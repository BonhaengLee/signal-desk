// 시뮬레이터.
// (시나리오, 시드)가 같으면 언제 어디서 돌려도 같은 이벤트열이 나온다. Date.now·Math.random 을 쓰지 않는다.
// 원인(배포·성능 저하)만 주입한다. 지연·에러율·경보·타임아웃·재시도 폭주는 아래 모델에서 생긴다.

import { SCHEMA_VERSION, type SignalEvent } from '../events/schema.ts';

export interface ServiceSpec {
  name: string;
  capacityRps: number; // 감당할 수 있는 초당 요청 수
  baseLatencyMs: number; // 한가할 때의 자체 처리 시간
  dependsOn?: string[]; // 요청마다 이 서비스들을 한 번씩 부른다
  timeoutMs?: number; // dependsOn 호출의 타임아웃
  retries?: number; // 타임아웃 난 호출을 몇 번 다시 보내는가
  alertP99Ms?: number; // 서비스별 경보 기준. 없으면 시나리오 기본값
  noiseLogRate?: number; // 틱마다 장애와 무관한 info 로그를 낼 확률
}

export interface Fault {
  atSec: number;
  untilSec?: number; // 이 시각에 원래 용량으로 돌아온다
  service: string;
  kind: 'deploy' | 'degrade'; // degrade 는 이벤트를 남기지 않는 저하 (디스크·노이지 네이버 등)
  capacityFactor: number; // 처리 용량 배율 (1 = 영향 없음)
  version?: string;
}

export interface Scenario {
  name: string;
  description: string;
  startAt: string; // 시뮬레이션 0초의 시각 (UTC ISO)
  durationSec: number;
  tickSec: number;
  entry: string; // 바깥 요청을 받는 서비스
  loadRps: number;
  alertP99Ms: number;
  services: ServiceSpec[];
  faults: Fault[];
  rootCause: { service: string; kind: Fault['kind']; atSec: number }; // 평가용 정답
}

/** 시드 하나로 같은 난수열을 내는 32비트 생성기 (mulberry32) */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 이용률이 1에 가까워질수록 대기 시간이 치솟는다 (M/M/1 대기열 근사). 이 값 이상은 포화로 본다
const SATURATION = 0.98;
const NOISE_LOGS = ['GET /healthz 200', 'cache refresh completed', 'gc pause 12ms', 'config reloaded'];

function queueLatency(baseMs: number, utilization: number): number {
  return baseMs / (1 - Math.min(utilization, SATURATION));
}

/** 의존 대상이 먼저 오는 순서. 순환이 있으면 거절한다 */
export function dependencyOrder(services: ServiceSpec[]): ServiceSpec[] {
  const byName = new Map(services.map((s) => [s.name, s]));
  const done = new Set<string>();
  const visiting = new Set<string>();
  const order: ServiceSpec[] = [];
  const visit = (name: string) => {
    if (done.has(name)) return;
    if (visiting.has(name)) throw new Error(`의존성 순환: ${name}`);
    const spec = byName.get(name);
    if (!spec) throw new Error(`정의되지 않은 서비스: ${name}`);
    visiting.add(name);
    for (const d of spec.dependsOn ?? []) visit(d);
    visiting.delete(name);
    done.add(name);
    order.push(spec);
  };
  for (const s of services) visit(s.name);
  return order;
}

type Draft = Pick<SignalEvent, 'type' | 'service' | 'payload'>;

export function* simulate(scenario: Scenario, seed: number): Generator<SignalEvent> {
  const rng = createRng(seed);
  const startMs = Date.parse(scenario.startAt);
  const depsFirst = dependencyOrder(scenario.services);
  const callersFirst = [...depsFirst].reverse();
  const capacityFactor = new Map(scenario.services.map((s) => [s.name, 1]));
  const firing = new Set<string>();
  // 직전 틱에 호출자→대상 호출 중 타임아웃 난 비율. 재시도가 다음 틱 부하를 키운다 (지연된 되먹임)
  let timeoutRate = new Map<string, number>();
  let seq = 0;

  const make = (draft: Draft, simSec: number): SignalEvent =>
    ({
      v: SCHEMA_VERSION,
      id: `simulator-${seed}-${seq}`,
      seq: seq++,
      source: 'simulator',
      at: new Date(startMs + Math.round(simSec * 1000)),
      ...draft,
    }) as SignalEvent;

  for (let t = 0; t < scenario.durationSec; t += scenario.tickSec) {
    for (const f of scenario.faults) {
      if (f.atSec === t) {
        capacityFactor.set(f.service, f.capacityFactor);
        if (f.kind === 'deploy') {
          yield make({ type: 'deploy', service: f.service, payload: { version: f.version ?? 'unknown', actor: 'ci' } }, t);
        }
      }
      if (f.untilSec === t) capacityFactor.set(f.service, 1);
    }

    // 1) 부하: 바깥 요청 → 호출자에서 대상으로 전파. 타임아웃 난 만큼 재시도가 얹힌다
    const load = new Map(scenario.services.map((s) => [s.name, 0]));
    load.set(scenario.entry, scenario.loadRps * (0.95 + rng() * 0.1));
    for (const s of callersFirst) {
      for (const d of s.dependsOn ?? []) {
        const rate = timeoutRate.get(`${s.name}->${d}`) ?? 0;
        load.set(d, load.get(d)! + load.get(s.name)! * (1 + (s.retries ?? 0) * rate));
      }
    }

    // 2) 지연: 대상부터 계산해 호출자 지연에 더한다
    const latency = new Map<string, number>();
    const util = new Map<string, number>();
    const nextTimeoutRate = new Map<string, number>();
    for (const s of depsFirst) {
      const u = load.get(s.name)! / (s.capacityRps * capacityFactor.get(s.name)!);
      util.set(s.name, u);
      let ms = queueLatency(s.baseLatencyMs, u);
      for (const d of s.dependsOn ?? []) {
        const dep = latency.get(d)!;
        const limit = s.timeoutMs ?? Infinity;
        ms += Math.min(dep, limit);
        const rate = dep > limit ? Math.min(1, Math.max(0.1, (dep - limit) / limit)) : 0;
        nextTimeoutRate.set(`${s.name}->${d}`, rate);
      }
      latency.set(s.name, ms);
    }
    timeoutRate = nextTimeoutRate;

    // 3) 관측: 대상(원인 쪽) 이벤트가 같은 시각 안에서 먼저 나온다
    for (const s of depsFirst) {
      const p99 = Math.round(latency.get(s.name)! * (1.8 + rng() * 0.2));
      yield make({ type: 'metric', service: s.name, payload: { name: 'latency_p99', value: p99, unit: 'ms' } }, t);

      if (s.dependsOn?.length) {
        const worst = Math.max(...s.dependsOn.map((d) => timeoutRate.get(`${s.name}->${d}`) ?? 0));
        const errPct = Math.round(worst * 1000) / 10;
        yield make({ type: 'metric', service: s.name, payload: { name: 'error_rate', value: errPct, unit: '%' } }, t);
      }

      const threshold = s.alertP99Ms ?? scenario.alertP99Ms;
      const rule = `latency_p99 > ${threshold}ms`;
      if (p99 > threshold && !firing.has(s.name)) {
        firing.add(s.name);
        const level = p99 > threshold * 2 ? 'error' : 'warn';
        yield make({ type: 'alert', service: s.name, payload: { level, rule, state: 'firing' } }, t);
      } else if (p99 <= threshold && firing.has(s.name)) {
        firing.delete(s.name);
        yield make({ type: 'alert', service: s.name, payload: { level: 'warn', rule, state: 'resolved' } }, t);
      }

      for (const d of s.dependsOn ?? []) {
        if ((timeoutRate.get(`${s.name}->${d}`) ?? 0) > 0) {
          const retry = s.retries ? `, retrying (${s.retries}x)` : '';
          yield make(
            { type: 'log', service: s.name, payload: { level: 'error', message: `upstream timeout: ${d} after ${s.timeoutMs}ms${retry}` } },
            t,
          );
        }
      }

      const u = util.get(s.name)!;
      if (u > 0.9 && rng() < 0.5) {
        const pct = Math.min(100, Math.round(u * 100));
        yield make({ type: 'log', service: s.name, payload: { level: 'warn', message: `request queue growing (utilization ${pct}%)` } }, t);
      }
      if (rng() < (s.noiseLogRate ?? 0)) {
        const message = NOISE_LOGS[Math.floor(rng() * NOISE_LOGS.length)]!;
        yield make({ type: 'log', service: s.name, payload: { level: 'info', message } }, t);
      }
    }
  }
}
