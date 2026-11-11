// RCAEval RE1-OB(Online Boutique, 지표만) 한 건을 Signal Desk 이벤트로 바꾼다.
// 데이터: https://doi.org/10.5281/zenodo.14590730 (CC BY 4.0). 저장소에는 넣지 않는다 (data/external/ 는 gitignore)
//
// - 형식이 두 가지다. cpu·mem 장애는 70분(주입 2100초 지점, latency·load), disk·delay·loss 는 12분(주입 360초 지점,
//   latency-50/90·workload). latency-90 → latency, workload → load 로 이름을 맞추고 latency-50 은 버린다
// - 조사 구간: 주입 최대 15분 전 ~ 5분 뒤. 지표는 1초 값을 10초 평균으로 줄인다
// - 경보: 원본에 없다. 지연·에러 지표가 평소(구간 시작 ~ 주입 1분 전) 평균 + 3σ 와 평균 × 1.5 를 둘 다 넘으면 울린다.
//   평소 구간을 주입 시각으로 잡는다는 점에서 주입 시각을 아는 셈이다 (RCAEval 의 다른 방법들도 같은 가정)
// - 정답: 폴더 이름 앞부분(adservice_cpu → adservice). 배포가 없으므로 종류는 모두 degrade

import { SCHEMA_VERSION, type SignalEvent } from '../events/schema.ts';
import type { ToolContext, Topology } from '../agent/tools.ts';

export const RCA_METRICS = ['latency', 'error', 'cpu', 'mem', 'load'];
// RCAEval RE1 에는 배포·로그가 없다. 지표 도구는 서비스 단위 한 장만 준다
export const RCA_TOOLS = ['get_topology', 'list_alerts', 'get_service_metrics', 'submit_root_cause'];
// 결합 방식: 통계 순위로 후보를 받고 에이전트가 검증한다
export const RCA_HYBRID_TOOLS = ['get_topology', 'list_alerts', 'rank_anomalies', 'get_service_metrics', 'submit_root_cause'];
export const MAX_BEFORE_SEC = 900;
export const AFTER_SEC = 300;
const STEP_SEC = 10;
const BASELINE_GAP_SEC = 60; // 평소 구간은 주입 1분 전까지
const RENAME: Record<string, string> = { latency: 'latency', 'latency-90': 'latency', error: 'error', cpu: 'cpu', mem: 'mem', load: 'load', workload: 'load' };

// 호출 관계: Online Boutique 공식 README 의 아키텍처 그림
// https://github.com/GoogleCloudPlatform/microservices-demo (docs/img/architecture-diagram.png)
export const OB_TOPOLOGY: Topology = {
  entry: 'frontend',
  services: [
    { name: 'frontend', dependsOn: ['adservice', 'recommendationservice', 'productcatalogservice', 'cartservice', 'shippingservice', 'currencyservice', 'checkoutservice'] },
    { name: 'checkoutservice', dependsOn: ['productcatalogservice', 'cartservice', 'shippingservice', 'currencyservice', 'paymentservice', 'emailservice'] },
    { name: 'recommendationservice', dependsOn: ['productcatalogservice'] },
    { name: 'cartservice', dependsOn: ['redis'] },
    { name: 'adservice', dependsOn: [] },
    { name: 'productcatalogservice', dependsOn: [] },
    { name: 'shippingservice', dependsOn: [] },
    { name: 'currencyservice', dependsOn: [] },
    { name: 'paymentservice', dependsOn: [] },
    { name: 'emailservice', dependsOn: [] },
    { name: 'redis', dependsOn: [] },
  ],
};
const SERVICES = new Set(OB_TOPOLOGY.services.map((s) => s.name));

export interface RcaCase {
  name: string; // adservice_cpu/1
  rootCause: string;
  fault: string; // cpu, mem, disk, delay, loss
  injectSec: number; // 조사 구간 시작부터 주입까지 초 (채점·기준선용. 에이전트에게는 주지 않는다)
  ctx: ToolContext;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const std = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};

/** csv 본문과 주입 시각(유닉스 초)으로 한 건을 만든다 */
/** afterSec: 조사 구간 끝을 주입 뒤 몇 초로 둘지. 평가는 AFTER_SEC(300초), 짧게 주면 '주입 직후에 조사를 연' 상황이다 */
export function loadCase(name: string, csv: string, injectTime: number, afterSec = AFTER_SEC): RcaCase {
  const [dir] = name.split('/');
  const [rootCause, fault] = dir!.split('_') as [string, string];
  const lines = csv.trim().split('\n');
  const header = lines[0]!.split(',');
  const timeCol = header.indexOf('time');
  // 서비스_지표 컬럼 중 이 프로젝트가 아는 서비스·지표만 쓴다 (main, PassthroughCluster 등 제외)
  const cols = header.flatMap((h, i) => {
    const k = h.lastIndexOf('_');
    const service = h.slice(0, k);
    const metric = RENAME[h.slice(k + 1)];
    return SERVICES.has(service) && metric ? [{ i, service, metric }] : [];
  });

  const firstTime = Number(lines[1]!.split(',')[timeCol]);
  const beforeSec = Math.min(MAX_BEFORE_SEC, Math.floor((injectTime - firstTime) / STEP_SEC) * STEP_SEC);
  const start = injectTime - beforeSec;
  const end = injectTime + afterSec;
  const series = new Map<number, number[]>(); // 컬럼 → 10초 평균 값들 (구간 순서대로)
  const sums = new Map<string, { sum: number; n: number }>();
  for (const line of lines.slice(1)) {
    const v = line.split(',');
    const t = Number(v[timeCol]);
    if (!(t >= start && t < end)) continue;
    const bucket = Math.floor((t - start) / STEP_SEC);
    for (const c of cols) {
      const x = Number(v[c.i]);
      if (!Number.isFinite(x)) continue;
      const key = `${c.i}:${bucket}`;
      const s = sums.get(key) ?? { sum: 0, n: 0 };
      s.sum += x;
      s.n += 1;
      sums.set(key, s);
    }
  }
  const buckets = (end - start) / STEP_SEC;
  for (const c of cols) {
    const xs: number[] = [];
    for (let b = 0; b < buckets; b++) {
      const s = sums.get(`${c.i}:${b}`);
      xs.push(s ? s.sum / s.n : NaN);
    }
    series.set(c.i, xs);
  }

  const startMs = start * 1000;
  const events: SignalEvent[] = [];
  let seq = 0;
  const at = (b: number) => new Date(startMs + b * STEP_SEC * 1000);
  const push = (e: Omit<SignalEvent, 'v' | 'id' | 'seq' | 'source'>) => {
    seq += 1;
    events.push({ v: SCHEMA_VERSION, id: `rca-${seq}`, seq, source: 'rcaeval', ...e } as SignalEvent);
  };

  // 경보: 지연·에러만. 사람이 보통 거는 경보와 같은 종류
  const baselineBuckets = (beforeSec - BASELINE_GAP_SEC) / STEP_SEC;
  const alertCols = cols.filter((c) => c.metric === 'latency' || c.metric === 'error');
  const firing = new Map<number, boolean>();
  const thresholds = new Map<number, number>();
  for (const c of alertCols) {
    const base = series.get(c.i)!.slice(0, baselineBuckets).filter(Number.isFinite);
    if (base.length < 10) continue;
    const m = mean(base);
    thresholds.set(c.i, Math.max(m + 3 * std(base), m * 1.5));
  }

  for (let b = 0; b < buckets; b++) {
    for (const c of cols) {
      const x = series.get(c.i)![b]!;
      if (!Number.isFinite(x)) continue;
      push({ type: 'metric', service: c.service, at: at(b), payload: { name: c.metric, value: x, unit: c.metric } });
      const th = thresholds.get(c.i);
      if (th === undefined || b < baselineBuckets) continue;
      const rule = `${c.metric} > ${Number(th.toPrecision(3))}`;
      if (x > th && !firing.get(c.i)) {
        firing.set(c.i, true);
        push({ type: 'alert', service: c.service, at: at(b), payload: { level: 'warn', rule, state: 'firing' } });
      } else if (x <= th && firing.get(c.i)) {
        firing.set(c.i, false);
        push({ type: 'alert', service: c.service, at: at(b), payload: { level: 'warn', rule, state: 'resolved' } });
      }
    }
  }

  return {
    name,
    rootCause,
    fault,
    injectSec: beforeSec,
    ctx: { events, topology: OB_TOPOLOGY, startMs, metrics: RCA_METRICS, bucketSec: 30, tools: RCA_TOOLS },
  };
}

/** 비교 기준: 주입 뒤 평소 대비 가장 크게 변한(z 점수 최대) 지표의 서비스 */
export function largestShiftBaseline(c: RcaCase): string | undefined {
  const byKey = new Map<string, number[]>();
  for (const e of c.ctx.events) {
    if (e.type !== 'metric') continue;
    const k = `${e.service} ${e.payload.name}`;
    (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(e.payload.value);
  }
  const baselineBuckets = (c.injectSec - BASELINE_GAP_SEC) / STEP_SEC;
  const injectBucket = c.injectSec / STEP_SEC;
  let best: { service: string; z: number } | undefined;
  for (const [k, xs] of byKey) {
    const base = xs.slice(0, baselineBuckets);
    const after = xs.slice(injectBucket);
    if (base.length < 10 || after.length === 0) continue;
    const z = Math.abs(mean(after) - mean(base)) / (std(base) || 1e-9);
    if (!best || z > best.z) best = { service: k.split(' ')[0]!, z };
  }
  return best?.service;
}
