import { test } from 'node:test';
import assert from 'node:assert/strict';
import { largestShiftBaseline, loadCase, RCA_TOOLS } from '../src/rcaeval/load.ts';
import { runTool, toolSpecsFor } from '../src/agent/tools.ts';

/** RE1-OB 의 짧은 형식(12분, 주입 360초 지점, latency-90·workload)을 흉내 낸 CSV.
 *  주입 뒤 adservice cpu 가 크게 오르고, frontend 지연이 조금 오른다 */
function csv(): { text: string; inject: number } {
  const t0 = 1_700_000_000;
  const inject = t0 + 360;
  const header = 'time,adservice_cpu,adservice_latency-50,adservice_latency-90,frontend_latency-90,frontend_workload,main_cpu';
  const rows = [header];
  for (let i = 0; i < 721; i++) {
    const after = t0 + i >= inject;
    const wobble = (i % 7) * 0.001; // 평소에도 조금씩 흔들린다
    rows.push([t0 + i, after ? 90 : 10 + (i % 3), 0.01, 0.02 + wobble, after ? 0.2 : 0.05 + wobble, 100, 5].join(','));
  }
  return { text: rows.join('\n'), inject };
}

test('형식 맞추기: latency-90 → latency, workload → load, latency-50·모르는 서비스(main)는 버린다', () => {
  const { text, inject } = csv();
  const c = loadCase('adservice_cpu/1', text, inject);
  assert.deepEqual([c.rootCause, c.fault, c.injectSec], ['adservice', 'cpu', 360]);
  const kinds = new Set(c.ctx.events.flatMap((e) => (e.type === 'metric' ? [`${e.service}.${e.payload.name}`] : [])));
  assert.deepEqual([...kinds].sort(), ['adservice.cpu', 'adservice.latency', 'frontend.latency', 'frontend.load']);
});

test('경보는 지연·에러만, 평소 대비 3σ 와 1.5배를 넘은 시점에 울린다', () => {
  const { text, inject } = csv();
  const c = loadCase('adservice_cpu/1', text, inject);
  const alerts = c.ctx.events.filter((e) => e.type === 'alert');
  // adservice cpu 는 크게 올랐지만 cpu 에는 경보를 걸지 않는다. frontend 지연만 울린다
  assert.deepEqual(
    alerts.map((a) => [a.service, Math.round((a.at.getTime() - c.ctx.startMs) / 1000), a.type === 'alert' && a.payload.state]),
    [['frontend', 360, 'firing']],
  );
});

test('가장 크게 변한 지표 기준선은 adservice 를 고른다', () => {
  const { text, inject } = csv();
  assert.equal(largestShiftBaseline(loadCase('adservice_cpu/1', text, inject)), 'adservice');
});

test('RCAEval 에는 배포·로그 도구를 주지 않고, 서비스 한 장 요약은 시각 열 하나에 지표 열을 붙인다', () => {
  const { text, inject } = csv();
  const c = loadCase('adservice_cpu/1', text, inject);
  assert.deepEqual(toolSpecsFor(c.ctx).map((t) => t.function.name), RCA_TOOLS);
  assert.deepEqual(runTool(c.ctx, 'list_deploys', {}), { error: '모르는 도구: list_deploys' });
  const m = runTool(c.ctx, 'get_service_metrics', { service: 'adservice' }) as Record<string, number[]>;
  assert.deepEqual(Object.keys(m), ['t', 'latency', 'cpu']);
  assert.equal(m.t!.length, 22); // 주입 360초 전 ~ 300초 뒤 = 660초 / 30초
  // 첫 30초: 10초 평균 10.9·11.0·11.1 의 최댓값. 마지막: 주입 뒤 90
  assert.deepEqual([m.cpu![0], m.cpu!.at(-1)], [11.1, 90]);
});
