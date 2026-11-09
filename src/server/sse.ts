// 시뮬레이터 이벤트를 SSE 로 흘려보내는 서버.
// 서버는 연결별 상태 말고는 아무것도 저장하지 않는다. 지금 몇 초째인지는 (고정 기준 시각, 현재 시각, 배속)으로 계산하므로
// 같은 시각에 접속한 방문자는 모두 같은 장면을 본다. 시나리오가 끝나면 처음부터 다시 돈다(cycle 이 1 늘어난다).

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { simulate, type Scenario } from '../simulator/simulate.ts';
import type { SignalEvent } from '../events/schema.ts';

export const SCENARIOS = ['deploy-regression', 'db-degradation', 'retry-storm', 'silent-db', 'hidden-deploy'] as const;
export const ANCHOR_MS = Date.parse('2026-01-01T00:00:00Z');
export const HEARTBEAT_MS = 15_000; // 프록시가 조용한 연결을 끊지 않도록 (Cloudflare 는 약 100초)
export const RETRY_MS = 2_000; // 끊겼을 때 브라우저가 다시 붙기까지 기다릴 시간

export interface Clock {
  now(): number;
}

export interface ServerOptions {
  clock?: Clock;
  tickMs?: number; // 새로 보낼 이벤트가 있는지 확인하는 간격
  heartbeatMs?: number;
  scenarioDir?: URL;
}

export interface StreamPosition {
  cycle: number;
  simSec: number;
}

export function positionAt(nowMs: number, speed: number, durationSec: number): StreamPosition {
  const elapsedSec = Math.max(0, ((nowMs - ANCHOR_MS) / 1000) * speed);
  return { cycle: Math.floor(elapsedSec / durationSec), simSec: elapsedSec % durationSec };
}

/** SSE 메시지 한 개. 빈 줄(\n\n)이 메시지의 끝이다 */
export function formatSse(fields: { id?: string; event?: string; data: string }): string {
  let out = '';
  if (fields.id !== undefined) out += `id: ${fields.id}\n`;
  if (fields.event !== undefined) out += `event: ${fields.event}\n`;
  for (const line of fields.data.split('\n')) out += `data: ${line}\n`;
  return out + '\n';
}

/** 'cycle:seq' 형식만 받는다. 그 밖의 값은 처음 접속으로 취급한다 */
export function parseLastEventId(raw: string | null | undefined): { cycle: number; seq: number } | undefined {
  const m = /^(\d+):(\d+)$/.exec(raw ?? '');
  return m ? { cycle: Number(m[1]), seq: Number(m[2]) } : undefined;
}

type Prepared = { scenario: Scenario; events: SignalEvent[]; simSecs: number[] };

export function createSseServer(options: ServerOptions = {}): http.Server {
  const clock = options.clock ?? { now: () => Date.now() };
  const tickMs = options.tickMs ?? 100;
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  const dir = options.scenarioDir ?? new URL('../../scenarios/', import.meta.url);
  const cache = new Map<string, Prepared>();

  // 시나리오 이름은 목록에 있는 것만 받는다. 사용자 입력으로 파일 경로를 만들지 않는다
  const prepare = (name: string, seed: number): Prepared | undefined => {
    if (!(SCENARIOS as readonly string[]).includes(name)) return undefined;
    const key = `${name}:${seed}`;
    let p = cache.get(key);
    if (!p) {
      const scenario = JSON.parse(readFileSync(new URL(`${name}.json`, dir), 'utf8')) as Scenario;
      const events = [...simulate(scenario, seed)];
      const start = Date.parse(scenario.startAt);
      p = { scenario, events, simSecs: events.map((e) => (e.at.getTime() - start) / 1000) };
      cache.set(key, p);
    }
    return p;
  };

  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/scenarios') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(SCENARIOS));
      return;
    }
    if (url.pathname !== '/events') {
      res.writeHead(404).end();
      return;
    }

    const seed = Number(url.searchParams.get('seed') ?? 42);
    const speed = Number(url.searchParams.get('speed') ?? 1);
    if (!Number.isInteger(seed) || !(speed > 0 && speed <= 100)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'seed 는 정수, speed 는 0 초과 100 이하' }));
      return;
    }
    const prepared = prepare(url.searchParams.get('scenario') ?? 'deploy-regression', seed);
    if (!prepared) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `알 수 없는 시나리오. 가능한 값: ${SCENARIOS.join(', ')}` }));
      return;
    }
    const { scenario, events, simSecs } = prepared;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // nginx 계열 프록시가 모아서 보내지 않도록
    });
    res.write(`retry: ${RETRY_MS}\n\n`);

    // 재연결이면 마지막으로 받은 다음 이벤트부터 이어서 보낸다
    const last = parseLastEventId(req.headers['last-event-id'] as string | undefined ?? url.searchParams.get('lastEventId'));
    const start = positionAt(clock.now(), speed, scenario.durationSec);
    let cycle = start.cycle;
    let next = 0;
    if (last && last.cycle === cycle) next = Math.min(last.seq + 1, events.length);
    else if (last) res.write(formatSse({ event: 'reset', data: JSON.stringify({ cycle }) }));

    const pump = () => {
      const pos = positionAt(clock.now(), speed, scenario.durationSec);
      if (pos.cycle !== cycle) {
        // 남은 이벤트를 마저 보내고 새 바퀴를 알린다
        for (; next < events.length; next++) send(next);
        cycle = pos.cycle;
        next = 0;
        res.write(formatSse({ event: 'reset', data: JSON.stringify({ cycle }) }));
      }
      for (; next < events.length && simSecs[next]! <= pos.simSec; next++) send(next);
    };
    const send = (i: number) => {
      res.write(formatSse({ id: `${cycle}:${events[i]!.seq}`, event: 'signal', data: JSON.stringify(events[i]) }));
    };

    pump();
    const timer = setInterval(pump, tickMs);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), heartbeatMs);
    req.on('close', () => {
      clearInterval(timer);
      clearInterval(heartbeat);
    });
  });
}
