// 조사·승인 API. SSE 서버에 붙는 라우트 묶음
//   POST /investigations                { scenario, seed?, atSec? }       → 202 { id }  (조사는 뒤에서 돈다. atSec 을 주면 그 초까지의 기록만 본다)
//   GET  /investigations/:id                                              → { events, proposals }
//   GET  /investigations/:id/stream     감사 로그를 SSE 로. id = seq 라 Last-Event-ID 로 이어 받는다
//   POST /proposals/:id/decision        { operator, decision, reason? }   → 승인이면 실행까지 기록. 이미 결정됐으면 409
// 인증은 없다. operator 는 요청 본문의 이름을 그대로 믿는다 (데모 범위의 한계). 그래서 서버는 기본으로 127.0.0.1 에만 열고(main.ts), 동시 조사 수를 묶는다

import type http from 'node:http';
import { readFileSync } from 'node:fs';
import { AuditStore, TransitionError, type Proposal } from '../audit/store.ts';
import type { ChatFn } from '../agent/agent.ts';
import { contextFor } from '../agent/eval.ts';
import { isScenario, parseAtSec, parseSeed, SCENARIOS } from '../simulator/catalog.ts';
import { runInvestigation } from '../agent/run.ts';
import type { Scenario } from '../simulator/simulate.ts';
import { formatSse, HEARTBEAT_MS } from './sse.ts';

export interface ApiOptions {
  store: AuditStore;
  chat: ChatFn;
  model: string;
  scenarioDir?: URL;
  pollMs?: number;
  heartbeatMs?: number;
  maxRunning?: number;
}

/** 동시에 도는 조사 수 상한. 조사 1건이 LLM 을 9회 안팎 부른다 */
export const MAX_RUNNING = 2;

const MAX_BODY = 10_000;
const UUID = '[0-9a-f-]{36}';
const TRANSITION_STATUS = { conflict: 409, invalid: 400, not_found: 404 } as const;

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown> | undefined> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) return undefined;
    chunks.push(c as Buffer);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** 처리한 요청이면 true. 아니면 다른 라우트로 넘긴다 */
export function createApiHandler(opts: ApiOptions) {
  const { store, chat, model } = opts;
  const dir = opts.scenarioDir ?? new URL('../../scenarios/', import.meta.url);
  const pollMs = opts.pollMs ?? 200;
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const maxRunning = opts.maxRunning ?? MAX_RUNNING;
  const running = new Set<Promise<void>>(); // 테스트·종료 시 기다릴 수 있게

  const proposalsOf = (id: string): Proposal[] =>
    (store.db.prepare('SELECT id FROM proposals WHERE investigation_id = ? ORDER BY created_at').all(id) as { id: string }[]).map(
      (r) => store.proposal(r.id)!,
    );
  const exists = (id: string) => store.db.prepare('SELECT 1 FROM investigations WHERE id = ?').get(id) !== undefined;

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    let m: RegExpExecArray | null;

    if (req.method === 'POST' && path === '/investigations') {
      const body = await readJson(req);
      const scenario = String(body?.scenario ?? '');
      if (!isScenario(scenario)) {
        json(res, 400, { error: `scenario 는 ${SCENARIOS.join(', ')} 중 하나` });
        return true;
      }
      const sd = parseSeed(body?.seed, 1);
      if (!sd.ok) return json(res, 400, { error: sd.error }), true;
      const s = JSON.parse(readFileSync(new URL(`${scenario}.json`, dir), 'utf8')) as Scenario;
      const at = parseAtSec(body?.atSec, s.durationSec);
      if (!at.ok) return json(res, 400, { error: at.error }), true;
      // 조사마다 LLM 을 여러 번 부른다. 인증이 없으므로 동시에 도는 수를 묶어 비용이 무한히 늘지 않게 한다
      if (running.size >= maxRunning) return json(res, 429, { error: `조사가 이미 ${running.size}건 돌고 있습니다. 끝난 뒤 다시 요청하세요` }), true;
      const { seed } = sd;
      const { atSec } = at;
      const id = store.createInvestigation(scenario, seed, model, atSec);
      const job = runInvestigation(store, id, contextFor(s, seed, atSec), chat).finally(() => running.delete(job));
      running.add(job);
      json(res, 202, { id });
      return true;
    }

    if (req.method === 'GET' && (m = new RegExp(`^/investigations/(${UUID})$`).exec(path))) {
      if (!exists(m[1]!)) return json(res, 404, { error: '없는 조사' }), true;
      json(res, 200, { events: store.events(m[1]!), proposals: proposalsOf(m[1]!) });
      return true;
    }

    if (req.method === 'GET' && (m = new RegExp(`^/investigations/(${UUID})/stream$`).exec(path))) {
      const id = m[1]!;
      if (!exists(id)) return json(res, 404, { error: '없는 조사' }), true;
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
      let after = Number(req.headers['last-event-id'] ?? 0) || 0;
      const pump = () => {
        for (const e of store.events(id, after)) {
          res.write(formatSse({ id: String(e.seq), event: e.kind, data: JSON.stringify(e) }));
          after = e.seq;
        }
      };
      pump();
      const timer = setInterval(pump, pollMs);
      const beat = setInterval(() => res.write(': ping\n\n'), heartbeatMs);
      req.on('close', () => {
        clearInterval(timer);
        clearInterval(beat);
      });
      return true;
    }

    if (req.method === 'POST' && (m = new RegExp(`^/proposals/(${UUID})/decision$`).exec(path))) {
      const body = await readJson(req);
      const decision = body?.decision;
      if (!body || (decision !== 'approved' && decision !== 'rejected') || typeof body.operator !== 'string') {
        json(res, 400, { error: 'operator(문자열), decision(approved|rejected) 필요' });
        return true;
      }
      try {
        // 승인이면 실행 기록까지 한 트랜잭션. 실제 조치는 시뮬레이션이라 기록만 남긴다
        json(res, 200, store.decideAndExecute(m[1]!, body.operator, decision, typeof body.reason === 'string' ? body.reason : undefined));
      } catch (e) {
        if (!(e instanceof TransitionError)) throw e;
        json(res, TRANSITION_STATUS[e.reason], { error: e.message });
      }
      return true;
    }

    return false;
  };

  return { handle, idle: () => Promise.all([...running]) };
}
