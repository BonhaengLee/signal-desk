import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { investigate, type ChatFn, type ChatMessage } from '../src/agent/agent.ts';
import { firstAlertBaseline, latestDeployBaseline } from '../src/agent/baseline.ts';
import { runTool } from '../src/agent/tools.ts';
import { contextFor, isCorrect, SCENARIO_FILES } from '../src/agent/eval.ts';
import type { Scenario } from '../src/simulator/simulate.ts';

const load = (name: string) => JSON.parse(readFileSync(`scenarios/${name}.json`, 'utf8')) as Scenario;

/** 각본대로 도구를 부르는 가짜 모델. 받은 대화를 기록한다 */
function scripted(calls: [string, Record<string, unknown>][][]): { chat: ChatFn; seen: ChatMessage[][] } {
  const seen: ChatMessage[][] = [];
  let i = 0;
  const chat: ChatFn = async (messages) => {
    seen.push(structuredClone(messages));
    const turn = calls[i++] ?? [];
    return {
      role: 'assistant',
      content: turn.length ? null : '말로만 답함',
      tool_calls: turn.map(([name, args], k) => ({ id: `c${i}-${k}`, function: { name, arguments: JSON.stringify(args) } })),
    };
  };
  return { chat, seen };
}

test('두 기준선은 각자 함정 시나리오에서 틀린다', () => {
  const score = (f: typeof latestDeployBaseline) =>
    SCENARIO_FILES.map((n) => {
      const s = load(n);
      return [1, 2, 3].every((seed) => isCorrect(f(contextFor(s, seed).events), s));
    });
  // deploy-regression, db-degradation, retry-storm, silent-db, hidden-deploy
  assert.deepEqual(score(latestDeployBaseline), [true, false, false, false, true]);
  assert.deepEqual(score(firstAlertBaseline), [true, true, true, false, false]);
});

test('도구 결과를 tool 메시지로 붙여 다음 턴에 보내고, 제출하면 끝낸다', async () => {
  const ctx = contextFor(load('db-degradation'), 1);
  const { chat, seen } = scripted([
    [['list_deploys', {}]],
    [['submit_root_cause', { service: 'payment-db', kind: 'degrade', evidence: 'T+70 이후 p99 상승' }]],
  ]);
  const r = await investigate(ctx, chat);
  assert.equal(r.stopReason, 'submitted');
  assert.deepEqual(r.verdict, { service: 'payment-db', kind: 'degrade', evidence: 'T+70 이후 p99 상승' });
  const tool = seen[1]!.at(-1)!;
  assert.equal(tool.role, 'tool');
  assert.deepEqual(JSON.parse(tool.content!), [{ t: 65, service: 'checkout-api', version: 'v3.1.0' }]);
});

test('잘못된 제출은 오류를 돌려주고 고칠 기회를 준다', async () => {
  const ctx = contextFor(load('retry-storm'), 1);
  const { chat, seen } = scripted([
    [['submit_root_cause', { service: 'database', kind: 'degrade', evidence: 'x' }]],
    [['submit_root_cause', { service: 'payment-db', kind: 'degrade', evidence: 'x' }]],
  ]);
  const r = await investigate(ctx, chat);
  assert.equal(r.verdict?.service, 'payment-db');
  assert.match(seen[1]!.at(-1)!.content!, /service 는 checkout-api, payment-api, inventory-api, payment-db 중 하나/);
});

test('도구를 안 부르면 한 번 재촉하고, 또 안 부르면 끝낸다', async () => {
  const { chat, seen } = scripted([[], []]);
  const r = await investigate(contextFor(load('retry-storm'), 1), chat);
  assert.deepEqual([r.stopReason, seen.length], ['no_tool_call', 2]);
});

test('호출 수 상한에서 멈춘다', async () => {
  const { chat } = scripted(Array.from({ length: 20 }, () => [['get_topology', {}]] as [string, Record<string, unknown>][]));
  const r = await investigate(contextFor(load('retry-storm'), 1), chat, 4);
  assert.deepEqual([r.stopReason, r.steps.length], ['max_steps', 4]);
});

test('get_metric 은 10초 구간 최댓값, get_logs 는 숫자만 다른 메시지를 묶는다', () => {
  const ctx = contextFor(load('retry-storm'), 1);
  const m = runTool(ctx, 'get_metric', { service: 'payment-db', name: 'latency_p99' }) as { t: number; max: number }[];
  assert.deepEqual(m.map((x) => x.t), Array.from({ length: 18 }, (_, i) => i * 10));
  const logs = runTool(ctx, 'get_logs', { service: 'payment-api' }) as { message: string; count: number }[];
  assert.equal(new Set(logs.map((l) => l.message)).size, logs.length);
  assert.deepEqual(runTool(ctx, 'get_logs', { service: 'nope' }), { error: '모르는 서비스: nope' });
});

test('기준선은 첫 경보 뒤의 배포는 고르지 않는다', () => {
  const ctx = contextFor(load('deploy-regression'), 1);
  const later = { ...ctx.events.find((e) => e.type === 'deploy')!, service: 'checkout-api', at: new Date(ctx.startMs + 170_000) };
  assert.equal(latestDeployBaseline([...ctx.events, later])?.service, 'payment-api');
});
