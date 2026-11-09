// 조사·승인 API. SSE 서버에 붙는 라우트 묶음
//   POST /investigations                { scenario, seed? }               → 202 { id }  (조사는 뒤에서 돈다)
//   GET  /investigations/:id                                              → { events, proposals }
//   GET  /investigations/:id/stream     감사 로그를 SSE 로. id = seq 라 Last-Event-ID 로 이어 받는다
//   POST /proposals/:id/decision        { operator, decision, reason? }   → 승인이면 실행까지 기록. 이미 결정됐으면 409
// 인증은 없다. operator 는 요청 본문의 이름을 그대로 믿는다 (데모 범위의 한계)

import type http from 'node:http';
import { readFileSync } from 'node:fs';
import { AuditStore, TransitionError, type Proposal } from '../audit/store.ts';
import type { ChatFn } from '../agent/agent.ts';
import { contextFor } from '../agent/eval.ts';
import { runInvestigation } from '../agent/run.ts';
import type { Scenario } from '../simulator/simulate.ts';
import { formatSse, HEARTBEAT_MS, SCENARIOS } from './sse.ts';

export interface ApiOptions {
  store: AuditStore;
  chat: ChatFn;
  model: string;
  scenarioDir?: URL;
  pollMs?: number;
  heartbeatMs?: number;
}

const MAX_BODY = 10_000;
const UUID = '[0-9a-f-]{36}';

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
      const seed = Number(body?.seed ?? 1);
      if (!(SCENARIOS as readonly string[]).includes(scenario) || !Number.isInteger(seed) || seed < 1) {
        json(res, 400, { error: `scenario 는 ${SCENARIOS.join(', ')} 중 하나, seed 는 1 이상 정수` });
        return true;
      }
      const s = JSON.parse(readFileSync(new URL(`${scenario}.json`, dir), 'utf8')) as Scenario;
      const id = store.createInvestigation(scenario, seed, model);
      const job = runInvestigation(store, id, contextFor(s, seed), chat).finally(() => running.delete(job));
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
      if (!store.proposal(m[1]!)) return json(res, 404, { error: '없는 제안' }), true;
      try {
        let p = store.decide(m[1]!, body.operator, decision, typeof body.reason === 'string' ? body.reason : undefined);
        if (p.status === 'approved') p = store.markExecuted(p.id); // 실제 조치는 시뮬레이션: 실행 기록만 남긴다
        json(res, 200, p);
      } catch (e) {
        if (!(e instanceof TransitionError)) throw e;
        json(res, e.message.includes('상태에서는') ? 409 : 400, { error: e.message });
      }
      return true;
    }

    return false;
  };

  return { handle, idle: () => Promise.all([...running]) };
}
