// 정적 데모: 서버 없이 미리 만든 파일(scripts/build-demo.ts)을 재생한다. VITE_DEMO=1 로 빌드할 때만 쓴다.
// subscribe 와 같은 모양으로 만들어 화면 코드는 어느 쪽을 쓰는지만 고른다.
// - /events: 시뮬레이터 이벤트를 배속에 맞춰 내보내고, 끝나면 reset 후 처음부터 (서버와 같은 id 'cycle:seq')
// - /investigations/:id/stream: 실제 모델로 돌린 조사 녹화를 단계마다 간격을 두고 내보낸다
// - 승인·거절: 브라우저 안에서만 반영하고 저장하지 않는다. 서버와 같은 규칙(이름 형식, 거절 사유, 한 번만 결정)을 따른다

import type { AuditEvent } from '../audit/store.ts';
import type { SseMessage } from '../client/sse.ts';
import type { SubscribeOptions } from '../client/subscribe.ts';

// Node 테스트에는 import.meta.env 가 없다
export const DEMO = import.meta.env?.VITE_DEMO === '1';
const BASE = `${import.meta.env?.BASE_URL ?? '/'}demo`;

/** 녹화 재생 간격: 실제 간격을 따르되 짧게 줄인다 */
export const STEP_MIN_MS = 500;
export const STEP_MAX_MS = 1500;

type Demo = { durationSec: number; events: { simSec: number; event: unknown }[] };
type Recording = { id: string; scenario: string; events: AuditEvent[] };

const json = async <T>(path: string): Promise<T> => {
  const res = await fetch(`${BASE}/${path}`);
  if (!res.ok) throw new DemoError(res.status, `데모 파일을 읽지 못했습니다 (${res.status})`);
  return (await res.json()) as T;
};

export class DemoError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });

/** 녹화 이벤트 사이 재생 간격 (ms) */
export function playbackGaps(events: readonly AuditEvent[]): number[] {
  return events.map((e, i) => {
    if (i === 0) return 0;
    const real = Date.parse(e.at) - Date.parse(events[i - 1]!.at);
    return Math.min(STEP_MAX_MS, Math.max(STEP_MIN_MS, Number.isFinite(real) ? real : STEP_MIN_MS));
  });
}

// 조사별 브라우저 안 결정 기록과 구독자. 새로고침하면 사라진다
const local = new Map<string, AuditEvent[]>();
const listeners = new Map<string, Set<(e: AuditEvent) => void>>();
const proposalOwner = new Map<string, string>(); // 제안 id → 조사 id

export async function demoSubscribe(url: string, opts: SubscribeOptions): Promise<void> {
  const { signal, onMessage, onStatus } = opts;
  const u = new URL(url, location.origin);
  onStatus?.('connecting');

  const inv = /^\/investigations\/([0-9a-f-]{36})\/stream$/.exec(u.pathname);
  if (inv) {
    const rec = await json<Recording>(`investigations/${inv[1]}.json`);
    onStatus?.('open');
    const emit = (e: AuditEvent) => onMessage({ event: e.kind, id: String(e.seq), data: JSON.stringify(e) } satisfies SseMessage);
    const gaps = playbackGaps(rec.events);
    for (let i = 0; i < rec.events.length && !signal.aborted; i++) {
      await wait(gaps[i]!, signal);
      if (signal.aborted) break;
      const e = rec.events[i]!;
      if (e.kind === 'proposal') proposalOwner.set(String((e.payload as { proposalId: string }).proposalId), rec.id);
      emit(e);
    }
    // 녹화가 끝난 뒤의 결정은 이 브라우저에서 한 것만
    for (const e of local.get(rec.id) ?? []) emit(e);
    const set = listeners.get(rec.id) ?? listeners.set(rec.id, new Set()).get(rec.id)!;
    set.add(emit);
    await wait(2 ** 31 - 1, signal);
    set.delete(emit);
    onStatus?.('closed');
    return;
  }

  const scenario = u.searchParams.get('scenario') ?? 'deploy-regression';
  const speed = Number(u.searchParams.get('speed') ?? 1);
  const demo = await json<Demo>(`events/${scenario}.json`);
  onStatus?.('open');
  const t0 = performance.now();
  let cycle = 0;
  let next = 0;
  while (!signal.aborted) {
    const elapsed = ((performance.now() - t0) / 1000) * speed;
    const c = Math.floor(elapsed / demo.durationSec);
    if (c !== cycle) {
      for (; next < demo.events.length; next++) send(next);
      cycle = c;
      next = 0;
      onMessage({ event: 'reset', data: JSON.stringify({ cycle }) });
    }
    const simSec = elapsed % demo.durationSec;
    for (; next < demo.events.length && demo.events[next]!.simSec <= simSec; next++) send(next);
    await wait(100, signal);
  }
  onStatus?.('closed');

  function send(i: number) {
    const e = demo.events[i]!.event as { seq: number };
    onMessage({ event: 'signal', id: `${cycle}:${e.seq}`, data: JSON.stringify(e) });
  }
}

/** 이 시나리오의 녹화 id. 녹화가 없으면 404 와 같은 오류 */
export async function demoStart(scenario: string): Promise<string> {
  const index = await json<Record<string, string>>('investigations/index.json');
  const id = index[scenario];
  if (!id) throw new DemoError(404, `${scenario} 는 데모 녹화가 없습니다`);
  return id;
}

/** 브라우저 안 결정. 규칙은 서버(src/audit/store.ts decide)와 같다 */
export function demoDecide(proposalId: string, operator: string, decision: 'approved' | 'rejected', reason?: string): void {
  if (!/^[\w.-]{1,40}$/.test(operator)) throw new DemoError(400, 'operator 는 영문·숫자·._- 1~40자');
  if (decision === 'rejected' && !reason?.trim()) throw new DemoError(400, '거절에는 사유가 필요하다');
  const id = proposalOwner.get(proposalId);
  if (!id) throw new DemoError(404, '없는 제안');
  const list = local.get(id) ?? local.set(id, []).get(id)!;
  if (list.some((e) => e.kind === 'decision')) throw new DemoError(409, '이미 결정된 제안입니다');
  const at = new Date().toISOString();
  const base = 1000 + list.length; // 녹화 seq 뒤에 붙인다
  const added: AuditEvent[] = [
    { seq: base, at, actor: `operator:${operator}`, kind: 'decision', payload: { proposalId, from: 'pending', to: decision, ...(reason ? { reason } : {}) } },
  ];
  if (decision === 'approved') added.push({ seq: base + 1, at, actor: 'system', kind: 'execution', payload: { proposalId, from: 'approved', to: 'executed' } });
  list.push(...added);
  for (const e of added) for (const l of listeners.get(id) ?? []) l(e);
}
