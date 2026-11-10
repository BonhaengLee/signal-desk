// 시나리오 × 시드마다 에이전트와 기준선의 정답률을 잰다. 정답 = 원인 서비스와 종류(deploy/degrade)가 모두 맞음
// 사용법: node --env-file=.env.local src/agent/eval.ts [시드 수] [모델] [실행 간격 ms]

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { simulate, type Scenario } from '../simulator/simulate.ts';
import { investigate, openAiChat, type ChatFn } from './agent.ts';
import { firstAlertBaseline, latestDeployBaseline } from './baseline.ts';
import type { Judgement, ToolContext, Verdict } from './tools.ts';

export const SCENARIO_FILES = ['deploy-regression', 'db-degradation', 'retry-storm', 'silent-db', 'hidden-deploy'];

export function contextFor(scenario: Scenario, seed: number): ToolContext {
  return {
    events: [...simulate(scenario, seed)],
    topology: {
      entry: scenario.entry,
      services: scenario.services.map((s) => ({ name: s.name, dependsOn: s.dependsOn ?? [] })),
    },
    startMs: Date.parse(scenario.startAt),
  };
}

export const isCorrect = (v: Judgement | undefined, s: Scenario) =>
  v !== undefined && v.service === s.rootCause.service && v.kind === s.rootCause.kind;

export interface Row {
  scenario: string;
  seed: number;
  agent: string; // "payment-api/deploy" 또는 실패 사유
  agentOk: boolean;
  measured: boolean; // false = API 오류로 결론을 못 냄. 오답이 아니라 측정 불가로 따로 센다
  baseline: string; // 최근 배포를 원인으로
  baselineOk: boolean;
  firstAlert: string; // 첫 경보 서비스를 원인으로
  firstAlertOk: boolean;
  steps: number;
  ms: number;
  stopReason?: string; // submitted, max_steps, no_tool_call
  formatRejects?: number; // 형식이 틀려 돌려보낸 제출 수
  trace?: string[]; // 단계 기록. 결과가 왜 바뀌었는지 다시 돌리지 않고 보려고 남긴다 (모델 출력은 매번 달라 재실행은 다른 표본이다)
}

/** 단계 한 줄: get_metric(payment-db, latency_p99) 또는 submit_root_cause ✖ 오류 */
export function traceLine(tool: string, args: Record<string, unknown>, result: unknown): string {
  if (tool === 'submit_root_cause') {
    const err = (result as { error?: string } | undefined)?.error;
    return err ? `submit_root_cause ✖ ${err}` : `submit_root_cause ✔ ${args.service}/${args.kind}`;
  }
  return `${tool}(${Object.values(args).map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(', ')})`;
}

export interface EvalOptions {
  prev?: Row[]; // 이전 실행 결과. 측정된 건은 다시 돌리지 않는다 (무료 쿼터 절약)
  pauseMs?: number; // 실행 사이 간격. Groq 무료 키는 분당 8,000토큰이고 조사 1건이 6천 토큰 안팎이라 65초
  onRow?: (rows: Row[]) => void;
}

export async function evaluate(chat: ChatFn, seeds: number[], opts: EvalOptions = {}): Promise<Row[]> {
  const rows: Row[] = [];
  let ran = 0;
  for (const name of SCENARIO_FILES) {
    const scenario = JSON.parse(readFileSync(`scenarios/${name}.json`, 'utf8')) as Scenario;
    for (const seed of seeds) {
      const done = opts.prev?.find((r) => r.scenario === name && r.seed === seed && r.measured);
      if (done) {
        rows.push(done);
        continue;
      }
      if (opts.pauseMs && ran++ > 0) await new Promise((r) => setTimeout(r, opts.pauseMs));
      const ctx = contextFor(scenario, seed);
      const base = latestDeployBaseline(ctx.events);
      const first = firstAlertBaseline(ctx.events);
      const t0 = performance.now();
      let agent = '';
      let verdict: Verdict | undefined;
      let steps = 0;
      let measured = true;
      let stopReason: string | undefined;
      const trace: string[] = [];
      try {
        const r = await investigate(ctx, chat, { onStep: (st, result) => trace.push(traceLine(st.tool, st.args, result)) });
        verdict = r.verdict;
        steps = r.steps.length;
        stopReason = r.stopReason;
        agent = verdict ? `${verdict.service}/${verdict.kind}` : r.stopReason;
      } catch (e) {
        agent = `오류: ${(e as Error).message.slice(0, 40)}`;
        measured = false;
      }
      rows.push({
        scenario: name,
        seed,
        agent,
        agentOk: isCorrect(verdict, scenario),
        measured,
        baseline: base ? `${base.service}/${base.kind}` : '-',
        baselineOk: isCorrect(base, scenario),
        firstAlert: first ? `${first.service}/${first.kind}` : '-',
        firstAlertOk: isCorrect(first, scenario),
        steps,
        ms: Math.round(performance.now() - t0),
        stopReason,
        formatRejects: trace.filter((l) => l.startsWith('submit_root_cause ✖')).length,
        trace,
      });
      console.error(`${name} seed=${seed} agent=${agent} base=${rows.at(-1)!.baseline}`);
      opts.onRow?.(rows); // 중간에 끊겨도 끝난 건은 남긴다
    }
  }
  return rows;
}

/** 기록이 있는 건만 더한다. 예전 결과 파일처럼 기록이 없으면 '-' */
function known(rows: Row[], f: (r: Row) => number | undefined): string {
  const xs = rows.map(f).filter((x): x is number => x !== undefined);
  return xs.length ? String(xs.reduce((a, b) => a + b, 0)) : '-';
}

export function summarize(rows: Row[]): string {
  const lines = [
    '| 시나리오 | 에이전트 | 최근 배포를 원인으로 | 첫 경보 서비스를 원인으로 | 평균 도구 호출 | 평균 소요(s) | 호출 상한 도달 | 형식 거부 |',
    '|---|---|---|---|---|---|---|---|',
  ];
  const groups = [...new Set(rows.map((r) => r.scenario)), '전체'];
  for (const g of groups) {
    const rs = g === '전체' ? rows : rows.filter((r) => r.scenario === g);
    const n = rs.length;
    const ms = rs.filter((r) => r.measured);
    const avg = (f: (r: Row) => number) => (ms.length ? ms.reduce((a, r) => a + f(r), 0) / ms.length : NaN).toFixed(1);
    const lost = n - ms.length;
    lines.push(
      `| ${g} | ${ms.filter((r) => r.agentOk).length}/${ms.length}${lost ? ` (측정 불가 ${lost})` : ''} | ${rs.filter((r) => r.baselineOk).length}/${n} | ${rs.filter((r) => r.firstAlertOk).length}/${n} | ${avg((r) => r.steps)} | ${avg((r) => r.ms / 1000)} | ${known(ms, (r) => (r.stopReason === undefined ? undefined : r.stopReason === 'max_steps' ? 1 : 0))} | ${known(ms, (r) => r.formatRejects)} |`,
    );
  }
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { LLM_BASE_URL, LLM_API_KEY } = process.env;
  if (!LLM_BASE_URL || !LLM_API_KEY) throw new Error('LLM_BASE_URL, LLM_API_KEY 필요 (.env.local)');
  const n = Number(process.argv[2] ?? 5);
  const model = process.argv[3] ?? 'gpt-oss-120b';
  mkdirSync('eval', { recursive: true });
  const file = `eval/${model}.json`;
  const prev: Row[] = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).map((r: Row) => ({ ...r, measured: r.measured ?? !r.agent.startsWith('오류') })) : [];
  const save = (rows: Row[]) => writeFileSync(file, JSON.stringify(rows, null, 2) + '\n');
  const seeds = Array.from({ length: n }, (_, i) => i + 1);
  const rows = await evaluate(openAiChat(LLM_BASE_URL, LLM_API_KEY, model), seeds, { prev, pauseMs: Number(process.argv[4] ?? 65_000), onRow: save });
  console.log(`모델: ${model}, 시드 ${n}개\n\n${summarize(rows)}`);
}
