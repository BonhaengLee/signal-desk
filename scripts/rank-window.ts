// RCAEval 규칙들의 정답률이 "조사를 주입 뒤 몇 초에 열었나"에 따라 어떻게 바뀌는지 잰다. LLM 을 부르지 않는다.
// 평가(src/rcaeval/eval.ts)는 주입 뒤 300초까지 보고, 순위 도구의 "최근 5분"이 주입 이후와 정확히 겹친다.
// 운영에서는 경보를 받고 몇십 초~몇 분 안에 조사를 연다. 그 상황에서도 순위가 맞는지 본다.
// 사용법: node scripts/rank-window.ts [회차...]   (데이터: data/external/rcaeval/RE1-OB)

import { firstAlertBaseline } from '../src/agent/baseline.ts';
import { rankAnomalies } from '../src/agent/tools.ts';
import { largestShiftBaseline } from '../src/rcaeval/load.ts';
import { listCases, readCase } from '../src/rcaeval/eval.ts';

export const AFTER_SECS = [30, 60, 120, 180, 300];

const runs = process.argv.slice(2).map(Number);
for (const run of runs.length ? runs : [1, 2]) {
  const names = listCases(run);
  console.log(`\n회차 ${run} (${names.length}건)\n`);
  console.log('| 주입 뒤 조사 시점 | 순위 1위 | 가장 크게 변한 지표 | 첫 경보 |');
  console.log('|---|---|---|---|');
  for (const afterSec of AFTER_SECS) {
    let rank = 0;
    let shift = 0;
    let first = 0;
    for (const name of names) {
      const c = readCase(name, afterSec);
      if (rankAnomalies(c.ctx)[0]?.service === c.rootCause) rank++;
      if (largestShiftBaseline(c) === c.rootCause) shift++;
      if (firstAlertBaseline(c.ctx.events)?.service === c.rootCause) first++;
    }
    console.log(`| ${afterSec}초 | ${rank}/${names.length} | ${shift}/${names.length} | ${first}/${names.length} |`);
  }
}
