// RCAEval RE1-OB 로 에이전트와 단순 규칙을 채점한다. 정답 = 원인 서비스 일치 (AC@1)
// 사용법: node --env-file=.env.local src/rcaeval/eval.ts [회차 1~5] [모델] [실행 간격 ms] [건수 상한] [agent|hybrid]
// agent = 에이전트 단독, hybrid = 통계 순위 도구(rank_anomalies)를 받은 에이전트
// 데이터는 data/external/rcaeval/RE1-OB 에 직접 받아 둔다 (README 참고). 끝난 건은 다시 돌리지 않는다

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { investigate, openAiChat, type ChatFn } from '../agent/agent.ts';
import { codeVersion } from '../agent/eval.ts';
import { firstAlertBaseline } from '../agent/baseline.ts';
import { rankAnomalies } from '../agent/tools.ts';
import { largestShiftBaseline, loadCase, RCA_HYBRID_TOOLS, RCA_TOOLS, type RcaCase } from './load.ts';

export type RcaMode = 'agent' | 'hybrid';

export const DATA_DIR = 'data/external/rcaeval/RE1-OB';
export const RCA_MAX_STEPS = 15; // 서비스 11개라 시뮬레이터(4개)의 10회로는 부족했다

export interface RcaRow {
  case: string;
  rootCause: string;
  fault: string;
  agent: string; // 제출한 서비스 또는 실패 사유
  agentOk: boolean;
  measured: boolean; // false = API 오류로 결론을 못 냄
  firstAlert: string;
  firstAlertOk: boolean;
  largestShift: string;
  largestShiftOk: boolean;
  rankTop?: string; // 보완 규칙: rank_anomalies 1위 (평소 흔들림 하한 적용)
  rankTopOk?: boolean;
  steps: number;
  ms: number;
  version?: string; // 이 행을 만든 코드의 codeVersion. 없으면 버전을 남기기 전의 결과
}

/** RCAEval 결과를 바꿀 수 있는 파일: 지시문·도구·기준선·데이터 변환·채점 */
export const RCA_EVAL_FILES = ['src/agent/agent.ts', 'src/agent/tools.ts', 'src/agent/baseline.ts', 'src/rcaeval/load.ts', 'src/rcaeval/eval.ts'];

export function listCases(run: number): string[] {
  return readdirSync(DATA_DIR)
    .filter((d) => existsSync(`${DATA_DIR}/${d}/${run}/data.csv`))
    .sort()
    .map((d) => `${d}/${run}`);
}

export function readCase(name: string, afterSec?: number): RcaCase {
  const dir = `${DATA_DIR}/${name}`;
  return loadCase(name, readFileSync(`${dir}/data.csv`, 'utf8'), Number(readFileSync(`${dir}/inject_time.txt`, 'utf8')), afterSec);
}

export async function evaluateRca(
  chat: ChatFn,
  names: string[],
  opts: { mode?: RcaMode; prev?: RcaRow[]; version?: string; pauseMs?: number; onRow?: (rows: RcaRow[]) => void } = {},
) {
  const rows: RcaRow[] = [];
  let ran = 0;
  for (const name of names) {
    const done = opts.prev?.find((r) => r.case === name && r.measured && r.version === opts.version);
    if (done) {
      rows.push(done);
      continue;
    }
    if (opts.pauseMs && ran++ > 0) await new Promise((r) => setTimeout(r, opts.pauseMs));
    const c = readCase(name);
    c.ctx.tools = opts.mode === 'hybrid' ? RCA_HYBRID_TOOLS : RCA_TOOLS;
    const rankTop = rankAnomalies(c.ctx)[0]?.service ?? '-';
    const first = firstAlertBaseline(c.ctx.events)?.service ?? '-';
    const shift = largestShiftBaseline(c) ?? '-';
    const t0 = performance.now();
    let agent = '';
    let steps = 0;
    let measured = true;
    try {
      const r = await investigate(c.ctx, chat, { maxSteps: RCA_MAX_STEPS });
      agent = r.verdict?.service ?? r.stopReason;
      steps = r.steps.length;
    } catch (e) {
      agent = `오류: ${(e as Error).message.slice(0, 40)}`;
      measured = false;
    }
    rows.push({
      case: name,
      rootCause: c.rootCause,
      fault: c.fault,
      agent,
      agentOk: agent === c.rootCause,
      measured,
      firstAlert: first,
      firstAlertOk: first === c.rootCause,
      largestShift: shift,
      largestShiftOk: shift === c.rootCause,
      rankTop,
      rankTopOk: rankTop === c.rootCause,
      steps,
      ms: Math.round(performance.now() - t0),
      version: opts.version,
    });
    console.error(`${name} agent=${agent} first=${first} shift=${shift} rank=${rankTop} answer=${c.rootCause}`);
    opts.onRow?.(rows);
  }
  return rows;
}

export function summarizeRca(rows: RcaRow[]): string {
  const lines = ['| 장애 종류 | 에이전트 | 첫 경보 서비스를 원인으로 | 가장 크게 변한 지표 | 보완 규칙(순위 1위) | 평균 도구 호출 |', '|---|---|---|---|---|---|'];
  for (const g of [...new Set(rows.map((r) => r.fault)), '전체']) {
    const rs = g === '전체' ? rows : rows.filter((r) => r.fault === g);
    const m = rs.filter((r) => r.measured);
    const lost = rs.length - m.length;
    const steps = m.length ? (m.reduce((a, r) => a + r.steps, 0) / m.length).toFixed(1) : '-';
    lines.push(
      // 규칙도 에이전트를 측정한 건만 센다. 분모가 다르면 같은 표 안에서 비교가 어긋난다
      `| ${g} | ${m.filter((r) => r.agentOk).length}/${m.length}${lost ? ` (측정 불가 ${lost})` : ''} | ${m.filter((r) => r.firstAlertOk).length}/${m.length} | ${m.filter((r) => r.largestShiftOk).length}/${m.length} | ${m.filter((r) => r.rankTopOk).length}/${m.length} | ${steps} |`,
    );
  }
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { LLM_BASE_URL, LLM_API_KEY } = process.env;
  if (!LLM_BASE_URL || !LLM_API_KEY) throw new Error('LLM_BASE_URL, LLM_API_KEY 필요 (.env.local)');
  const run = Number(process.argv[2] ?? 1);
  const model = process.argv[3] ?? 'nemotron-3.5-lightning-30b-a3b';
  const pauseMs = Number(process.argv[4] ?? 5000);
  const limit = Number(process.argv[5] ?? Infinity);
  const mode = (process.argv[6] ?? 'agent') as RcaMode;
  if (mode !== 'agent' && mode !== 'hybrid') throw new Error('mode 는 agent 또는 hybrid');
  const file = `eval/rcaeval-RE1-OB-run${run}-${model}${mode === 'hybrid' ? '-hybrid' : ''}.json`;
  mkdirSync('eval', { recursive: true });
  const prev: RcaRow[] = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  const names = listCases(run).slice(0, limit);
  const version = codeVersion(RCA_EVAL_FILES);
  const rows = await evaluateRca(openAiChat(LLM_BASE_URL, LLM_API_KEY, model), names, {
    mode,
    prev,
    version,
    pauseMs,
    onRow: (rs) => writeFileSync(file, JSON.stringify([...rs, ...prev.filter((p) => !rs.some((r) => r.case === p.case))], null, 2) + '\n'),
  });
  console.log(`RCAEval RE1-OB 회차 ${run}, 모델 ${model}, ${mode}\n\n${summarizeRca(rows)}`);
}
