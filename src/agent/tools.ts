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
}

export type RootCauseKind = 'deploy' | 'degrade';
export interface Verdict {
  service: string;
  kind: RootCauseKind;
  evidence: string;
}

/** OpenAI 호환 tools 정의 */
export const TOOL_SPECS = [
  fn('get_topology', '서비스 목록과 호출 관계(누가 누구를 부르는가)', {}),
  fn('list_alerts', '울렸거나 해소된 경보 전체 (T+초 순)', {}),
  fn('list_deploys', '배포 이력 전체 (T+초 순)', {}),
  fn('get_metric', '한 서비스의 지표를 10초 간격으로 요약', {
    service: { type: 'string' },
    name: { type: 'string', enum: ['latency_p99', 'error_rate'] },
  }, ['service', 'name']),
  fn('get_logs', '한 서비스의 warn·error 로그를 메시지별로 묶어 처음 나온 시각과 건수', {
    service: { type: 'string' },
  }, ['service']),
  fn('submit_root_cause', '조사를 끝내고 근본 원인을 제출한다. 반드시 마지막에 한 번 호출', {
    service: { type: 'string', description: '원인 서비스' },
    kind: { type: 'string', enum: ['deploy', 'degrade'], description: 'deploy=배포 탓, degrade=배포 없이 성능 저하' },
    evidence: { type: 'string', description: '판단 근거 2~3개, T+초 포함' },
  }, ['service', 'kind', 'evidence']),
] as const;

function fn(name: string, description: string, properties: Record<string, unknown>, required: string[] = []) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}

const tsec = (ctx: ToolContext, e: SignalEvent) => Math.round((e.at.getTime() - ctx.startMs) / 1000);

/** 도구 실행. 잘못된 인자는 예외 대신 오류 문자열로 돌려줘서 모델이 고칠 기회를 준다 */
export function runTool(ctx: ToolContext, name: string, args: Record<string, unknown>): unknown {
  const known = new Set(ctx.topology.services.map((s) => s.name));
  const svc = typeof args.service === 'string' ? args.service : '';
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
      const buckets = new Map<number, number>();
      for (const e of ctx.events) {
        if (e.type !== 'metric' || e.service !== svc || e.payload.name !== args.name) continue;
        const b = Math.floor(tsec(ctx, e) / 10) * 10;
        buckets.set(b, Math.max(buckets.get(b) ?? 0, e.payload.value)); // 구간 최댓값
      }
      return [...buckets].map(([t, max]) => ({ t, max: Math.round(max * 10) / 10 }));
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

/** submit_root_cause 인자 검증. 모델 출력은 신뢰 경계 밖이다 */
export function parseVerdict(args: unknown, known: Set<string>): { ok: true; verdict: Verdict } | { ok: false; error: string } {
  const a = (args ?? {}) as Record<string, unknown>;
  if (typeof a.service !== 'string' || !known.has(a.service)) return { ok: false, error: `service 는 ${[...known].join(', ')} 중 하나` };
  if (a.kind !== 'deploy' && a.kind !== 'degrade') return { ok: false, error: 'kind 는 deploy 또는 degrade' };
  if (typeof a.evidence !== 'string' || a.evidence.trim() === '') return { ok: false, error: 'evidence 필요' };
  return { ok: true, verdict: { service: a.service, kind: a.kind, evidence: a.evidence } };
}
