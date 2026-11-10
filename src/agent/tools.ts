// 에이전트가 부를 수 있는 조사 도구. 이벤트 목록을 받아 사람이 대시보드에서 보는 정도의 요약만 돌려준다.
// 원본 이벤트를 통째로 넘기지 않는 이유: 270건을 매번 넣으면 토큰이 커지고, 모델이 숫자를 직접 훑다가 틀린다

import type { SignalEvent } from '../events/schema.ts';

export interface Topology {
  entry: string;
  services: { name: string; dependsOn: string[] }[];
}

export interface ToolContext {
  events: SignalEvent[];
  topology: Topology;
  startMs: number; // 시나리오 0초. 시각은 T+초로만 보여 준다
  metrics?: string[]; // get_metric 이 받는 지표 이름. 없으면 시뮬레이터 지표
  bucketSec?: number; // get_metric 요약 간격. 기본 10초
  tools?: string[]; // 이 데이터에서 쓸 수 있는 도구. 없으면 시뮬레이터 기본 도구 전부. 데이터에 없는 정보(배포·로그)의 도구는 빼서 헛걸음을 막는다
}

export const SIM_METRICS = ['latency_p99', 'error_rate'];

// deploy = 특정 배포가 원인(롤백하면 풀린다), degrade = 배포와 무관한 성능 저하(담당자를 부른다)
export type RootCauseKind = 'deploy' | 'degrade';
/** 원인 서비스와 종류. 채점과 기준선은 이것만 본다 */
export interface Judgement {
  service: string;
  kind: RootCauseKind;
}
/** 에이전트의 제출. 근거는 몇 번째 도구 호출 결과에서 나왔는지 번호로 가리켜 사람이 원본과 대조할 수 있게 한다 */
export interface Verdict extends Judgement {
  summary: string; // 왜 이 서비스인가, 한 문장
  evidence: { step: number; fact: string }[]; // step = 1부터 센 도구 호출 번호
  ruledOut: { service: string; why: string }[]; // 의심했다가 버린 후보
}

/** OpenAI 호환 tools 정의. 지표 이름과 요약 간격은 데이터마다 다르다 */
export const SIM_TOOLS = ['get_topology', 'list_alerts', 'list_deploys', 'get_metric', 'get_logs', 'submit_root_cause'];

export function toolSpecsFor(ctx: Pick<ToolContext, 'metrics' | 'bucketSec' | 'tools'> = {}) {
  const allowed = new Set(ctx.tools ?? SIM_TOOLS);
  return [
  fn('get_topology', '서비스 목록과 호출 관계(누가 누구를 부르는가)', {}),
  fn('list_alerts', '울렸거나 해소된 경보 전체 (T+초 순)', {}),
  fn('list_deploys', '배포 이력 전체 (T+초 순)', {}),
  fn('get_metric', `한 서비스의 지표를 ${ctx.bucketSec ?? 10}초 간격 구간 최댓값으로 요약`, {
    service: { type: 'string' },
    name: { type: 'string', enum: ctx.metrics ?? SIM_METRICS },
  }, ['service', 'name']),
  fn('rank_anomalies', '최근 5분 지표를 그 앞(1분 간격 두고)의 평소 값과 비교해 크게 변한 순서로 상위 8개. 순위가 높다고 원인은 아니다. 경보·호출 관계·다른 지표로 검증할 것', {}),
  fn('get_service_metrics', `한 서비스의 지표 전부(${(ctx.metrics ?? SIM_METRICS).join('·')})를 ${ctx.bucketSec ?? 10}초 간격 구간 최댓값으로 한 번에 요약. 서비스별 대시보드 한 장`, {
    service: { type: 'string' },
  }, ['service']),
  fn('get_logs', '한 서비스의 warn·error 로그를 메시지별로 묶어 처음 나온 시각과 건수', {
    service: { type: 'string' },
  }, ['service']),
  fn('submit_root_cause', '조사를 끝내고 근본 원인을 제출한다. 반드시 마지막에 한 번 호출. 글은 모두 한국어로', {
    service: { type: 'string', description: '원인 서비스' },
    kind: { type: 'string', enum: ['deploy', 'degrade'], description: 'deploy=특정 배포가 원인(롤백 대상), degrade=배포와 무관한 성능 저하' },
    summary: { type: 'string', description: '왜 이 서비스가 원인인가 한 문장. 예: payment-db 지연이 먼저 오르고 위쪽 서비스가 뒤따라 올랐다' },
    evidence: {
      type: 'array',
      description: '근거 1~4개. step 은 그 사실을 본 도구 결과의 step 번호, fact 는 T+초와 값을 넣은 한 줄',
      items: { type: 'object', properties: { step: { type: 'integer' }, fact: { type: 'string' } }, required: ['step', 'fact'] },
    },
    ruledOut: {
      type: 'array',
      description: '의심했다가 버린 다른 서비스 1~3개와 버린 이유',
      items: { type: 'object', properties: { service: { type: 'string' }, why: { type: 'string' } }, required: ['service', 'why'] },
    },
  }, ['service', 'kind', 'summary', 'evidence', 'ruledOut']),
  ].filter((t) => allowed.has(t.function.name));
}

export type ToolSpec = ReturnType<typeof fn>;
export const TOOL_SPECS = toolSpecsFor();

function fn(name: string, description: string, properties: Record<string, unknown>, required: string[] = []) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}

const tsec = (ctx: ToolContext, e: SignalEvent) => Math.round((e.at.getTime() - ctx.startMs) / 1000);

// 10 이상은 소수 첫째 자리, 그 아래는 유효숫자 3자리 (초 단위 지연 0.012 같은 값이 0 으로 뭉개지지 않게)
const round = (v: number) => (Math.abs(v) >= 10 ? Math.round(v * 10) / 10 : Number(v.toPrecision(3)));

export const RECENT_SEC = 300; // 운영자가 경보를 받고 대시보드를 연 시점의 "최근" 구간
const GAP_SEC = 60; // 최근 직전 1분은 평소에서 뺀다 (변화가 막 시작됐을 수 있다)
const MIN_REL_SPREAD = 0.05; // 평소 흔들림의 하한 = 평소 값의 5%. 거의 안 움직이던 지표의 미세 변화가 1위가 되는 것을 막는다

/** 서비스·지표마다 최근 평균이 평소 평균에서 몇 배의 흔들림만큼 벗어났는지(z) 큰 순서로 */
export function rankAnomalies(ctx: ToolContext): { service: string; metric: string; before: number; recent: number; z: number }[] {
  const series = new Map<string, { t: number; v: number }[]>();
  let end = -Infinity;
  for (const e of ctx.events) {
    if (e.type !== 'metric') continue;
    const k = `${e.service}\u0000${e.payload.name}`;
    const t = tsec(ctx, e);
    end = Math.max(end, t);
    (series.get(k) ?? series.set(k, []).get(k)!).push({ t, v: e.payload.value });
  }
  const recentFrom = end - RECENT_SEC;
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const out = [];
  for (const [k, pts] of series) {
    const base = pts.filter((p) => p.t < recentFrom - GAP_SEC).map((p) => p.v);
    const recent = pts.filter((p) => p.t > recentFrom).map((p) => p.v);
    if (base.length < 5 || recent.length === 0) continue;
    const m = avg(base);
    const sd = Math.sqrt(avg(base.map((x) => (x - m) ** 2)));
    const spread = Math.max(sd, Math.abs(m) * MIN_REL_SPREAD, 1e-9);
    const [service, metric] = k.split('\u0000') as [string, string];
    out.push({ service, metric, before: m, recent: avg(recent), z: Math.abs(avg(recent) - m) / spread });
  }
  return out.sort((a, b) => b.z - a.z);
}

/** 한 서비스·지표를 bucketSec 구간 최댓값으로 묶는다. 키 = 구간 시작 T+초 */
function bucketMax(ctx: ToolContext, service: string, metric: string): Map<number, number> {
  const step = ctx.bucketSec ?? 10;
  const buckets = new Map<number, number>();
  for (const e of ctx.events) {
    if (e.type !== 'metric' || e.service !== service || e.payload.name !== metric) continue;
    const b = Math.floor(tsec(ctx, e) / step) * step;
    buckets.set(b, Math.max(buckets.get(b) ?? -Infinity, e.payload.value));
  }
  return buckets;
}

/** 도구 실행. 잘못된 인자는 예외 대신 오류 문자열로 돌려줘서 모델이 고칠 기회를 준다 */
export function runTool(ctx: ToolContext, name: string, args: Record<string, unknown>): unknown {
  const known = new Set(ctx.topology.services.map((s) => s.name));
  const svc = typeof args.service === 'string' ? args.service : '';
  if (!(ctx.tools ?? SIM_TOOLS).includes(name)) return { error: `모르는 도구: ${name}` };
  switch (name) {
    case 'get_topology':
      return ctx.topology;
    case 'list_alerts':
      return ctx.events.flatMap((e) =>
        e.type === 'alert' ? [{ t: tsec(ctx, e), service: e.service, ...e.payload }] : [],
      );
    case 'list_deploys':
      return ctx.events.flatMap((e) =>
        e.type === 'deploy' ? [{ t: tsec(ctx, e), service: e.service, version: e.payload.version }] : [],
      );
    case 'get_metric': {
      if (!known.has(svc)) return { error: `모르는 서비스: ${svc}` };
      return [...bucketMax(ctx, svc, String(args.name))].map(([t, max]) => ({ t, max: round(max) }));
    }
    case 'rank_anomalies':
      return rankAnomalies(ctx).slice(0, 8).map((r) => ({ ...r, before: round(r.before), recent: round(r.recent), z: round(r.z) }));
    case 'get_service_metrics': {
      if (!known.has(svc)) return { error: `모르는 서비스: ${svc}` };
      // 시각 열 하나 + 지표마다 값 열 하나. 객체 배열보다 토큰이 훨씬 적다
      const out: Record<string, number[]> = {};
      for (const m of ctx.metrics ?? SIM_METRICS) {
        const b = bucketMax(ctx, svc, m);
        if (b.size === 0) continue;
        out.t ??= [...b.keys()];
        out[m] = out.t.map((t) => round(b.get(t) ?? NaN));
      }
      return out;
    }
    case 'get_logs': {
      if (!known.has(svc)) return { error: `모르는 서비스: ${svc}` };
      const groups = new Map<string, { level: string; first: number; count: number }>();
      for (const e of ctx.events) {
        if (e.type !== 'log' || e.service !== svc || e.payload.level === 'info') continue;
        const key = e.payload.message.replace(/\d+/g, 'N'); // 숫자만 다른 메시지는 하나로
        const g = groups.get(key);
        if (g) g.count += 1;
        else groups.set(key, { level: e.payload.level, first: tsec(ctx, e), count: 1 });
      }
      return [...groups].map(([message, g]) => ({ message, ...g }));
    }
    default:
      return { error: `모르는 도구: ${name}` };
  }
}

/** submit_root_cause 인자 검증. 모델 출력은 신뢰 경계 밖이다.
 *  prior = 이 제출 전까지의 도구 호출(1번부터). 근거 번호는 실제로 부른 조사 도구여야 한다 */
export function parseVerdict(
  args: unknown,
  known: Set<string>,
  prior: { tool: string }[],
): { ok: true; verdict: Verdict } | { ok: false; error: string } {
  const a = (args ?? {}) as Record<string, unknown>;
  const ko = (v: unknown, max: number) => typeof v === 'string' && HANGUL.test(v) && v.trim().length <= max;
  // 틀린 칸을 한꺼번에 알려 준다. 하나씩 알려 주면 고칠 때마다 호출이 하나씩 든다
  const errors = new Set<string>();
  if (typeof a.service !== 'string' || !known.has(a.service)) errors.add(`service 는 ${[...known].join(', ')} 중 하나`);
  if (a.kind !== 'deploy' && a.kind !== 'degrade') errors.add('kind 는 deploy 또는 degrade');
  if (!ko(a.summary, 200)) errors.add('summary 는 한국어 한 문장 (200자 이하)');
  const ev = a.evidence;
  if (!Array.isArray(ev) || ev.length < 1 || ev.length > 4) errors.add('evidence 는 1~4개 배열');
  else
    for (const e of ev as Record<string, unknown>[]) {
      const step = e?.step;
      if (!Number.isInteger(step) || (step as number) < 1 || (step as number) > prior.length || prior[(step as number) - 1]!.tool === 'submit_root_cause')
        errors.add(`evidence.step 은 이미 부른 조사 도구 번호 (1~${prior.length})`);
      if (!ko(e?.fact, 200)) errors.add('evidence.fact 는 한국어 한 줄 (200자 이하)');
    }
  const ro = a.ruledOut;
  if (!Array.isArray(ro) || ro.length < 1 || ro.length > 3) errors.add('ruledOut 은 버린 후보 1~3개 배열');
  else
    for (const r of ro as Record<string, unknown>[]) {
      if (typeof r?.service !== 'string' || !known.has(r.service) || r.service === a.service) errors.add('ruledOut.service 는 원인이 아닌 다른 서비스');
      if (!ko(r?.why, 200)) errors.add('ruledOut.why 는 한국어 한 줄 (200자 이하)');
    }
  if (errors.size > 0) return { ok: false, error: [...errors].join(' / ') };
  return {
    ok: true,
    verdict: {
      service: a.service as string,
      kind: a.kind as RootCauseKind,
      summary: (a.summary as string).trim(),
      evidence: (ev as { step: number; fact: string }[]).map((e) => ({ step: e.step, fact: e.fact.trim() })),
      ruledOut: (ro as { service: string; why: string }[]).map((r) => ({ service: r.service, why: r.why.trim() })),
    },
  };
}
const HANGUL = /[가-힣]/;
