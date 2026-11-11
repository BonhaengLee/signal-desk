// 시나리오 × 시드마다 에이전트와 기준선의 정답률을 잰다. 정답 = 원인 서비스와 종류(deploy/degrade)가 모두 맞음
// 사용법: node --env-file=.env.local src/agent/eval.ts [시드 수] [모델] [실행 간격 ms]

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { simulate, type Scenario } from '../simulator/simulate.ts';
import { investigate, openAiChat, type ChatFn } from './agent.ts';
import { firstAlertBaseline, latestDeployBaseline } from './baseline.ts';
import type { Judgement, ToolContext, Verdict } from './tools.ts';
import { SCENARIOS } from '../simulator/catalog.ts';


/** 조사 대상. atSec 을 주면 시나리오 시작부터 그 초까지의 이벤트만 넘긴다 (화면이 보고 있는 시점까지만 아는 에이전트).
 *  평가는 atSec 없이 전체 기록으로 채점한다 */
export function contextFor(scenario: Scenario, seed: number, atSec?: number): ToolContext {
  const start = Date.parse(scenario.startAt);
  const all = [...simulate(scenario, seed)];
  return {
    events: atSec === undefined ? all : all.filter((e) => (e.at.getTime() - start) / 1000 <= atSec),
    topology: {
      entry: scenario.entry,
      services: scenario.services.map((s) => ({ name: s.name, dependsOn: s.dependsOn ?? [] })),
    },
    startMs: start,
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
  version?: string; // 이 행을 만든 코드의 codeVersion. 없으면 버전을 남기기 전의 결과
}

/** 결과에 영향을 주는 파일 내용의 해시(12자리). 이전 결과는 이 값이 같을 때만 다시 쓴다.
 *  커밋 해시 대신 내용 해시를 쓰는 이유: 커밋하지 않은 수정으로 돌린 결과도 구분해야 한다 */
export function codeVersion(paths: readonly string[]): string {
  const h = createHash('sha256');
  for (const p of [...paths].sort()) h.update(p).update('\0').update(readFileSync(p)).update('\0');
  return h.digest('hex').slice(0, 12);
}

/** 시뮬레이터 평가 결과를 바꿀 수 있는 파일: 지시문·도구·채점·기준선·시뮬레이터·시나리오 */
export const SIM_EVAL_FILES = [
  'src/agent/agent.ts',
  'src/agent/tools.ts',
  'src/agent/eval.ts',
  'src/agent/baseline.ts',
  'src/simulator/simulate.ts',
  ...SCENARIOS.map((n) => `scenarios/${n}.json`),
];

/** 단계 한 줄: get_metric(payment-db, latency_p99) 또는 submit_root_cause ✖ 오류 */
export function traceLine(tool: string, args: Record<string, unknown>, result: unknown): string {
  if (tool === 'submit_root_cause') {
    const err = (result as { error?: string } | undefined)?.error;
    return err ? `submit_root_cause ✖ ${err}` : `submit_root_cause ✔ ${args.service}/${args.kind}`;
  }
  return `${tool}(${Object.values(args).map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(', ')})`;
}

export interface EvalOptions {
  prev?: Row[]; // 이전 실행 결과. 같은 코드 버전으로 측정된 건은 다시 돌리지 않는다 (무료 쿼터 절약)
  version?: string; // 지금 코드의 codeVersion. 다른 버전으로 잰 행은 다시 쓰지 않는다
  pauseMs?: number; // 실행 사이 간격. Groq 무료 키는 분당 8,000토큰이고 조사 1건이 6천 토큰 안팎이라 65초
  onRow?: (rows: Row[]) => void;
}

export async function evaluate(chat: ChatFn, seeds: number[], opts: EvalOptions = {}): Promise<Row[]> {
  const rows: Row[] = [];
  let ran = 0;
  for (const name of SCENARIOS) {
    const scenario = JSON.parse(readFileSync(`scenarios/${name}.json`, 'utf8')) as Scenario;
    for (const seed of seeds) {
      const done = opts.prev?.find((r) => r.scenario === name && r.seed === seed && r.measured && r.version === opts.version);
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
        version: opts.version,
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
    // 규칙도 에이전트를 측정한 건만 센다. 분모가 다르면 같은 표 안에서 비교가 어긋난다
    lines.push(
      `| ${g} | ${ms.filter((r) => r.agentOk).length}/${ms.length}${lost ? ` (측정 불가 ${lost})` : ''} | ${ms.filter((r) => r.baselineOk).length}/${ms.length} | ${ms.filter((r) => r.firstAlertOk).length}/${ms.length} | ${avg((r) => r.steps)} | ${avg((r) => r.ms / 1000)} | ${known(ms, (r) => (r.stopReason === undefined ? undefined : r.stopReason === 'max_steps' ? 1 : 0))} | ${known(ms, (r) => r.formatRejects)} |`,
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
  const version = codeVersion(SIM_EVAL_FILES);
  const rows = await evaluate(openAiChat(LLM_BASE_URL, LLM_API_KEY, model), seeds, { prev, version, pauseMs: Number(process.argv[4] ?? 65_000), onRow: save });
  console.log(`모델: ${model}, 시드 ${n}개, 코드 버전 ${version}\n\n${summarize(rows)}`);
}
