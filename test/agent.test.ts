import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { investigate, type ChatFn, type ChatMessage } from '../src/agent/agent.ts';
import { firstAlertBaseline, latestDeployBaseline } from '../src/agent/baseline.ts';
import { parseVerdict, runTool } from '../src/agent/tools.ts';
import { codeVersion, contextFor, evaluate, isCorrect, summarize, traceLine, type Row } from '../src/agent/eval.ts';
import { SCENARIOS } from '../src/simulator/catalog.ts';
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
    SCENARIOS.map((n) => {
      const s = load(n);
      return [1, 2, 3].every((seed) => isCorrect(f(contextFor(s, seed).events), s));
    });
  // deploy-regression, db-degradation, retry-storm, silent-db, hidden-deploy
  assert.deepEqual(score(latestDeployBaseline), [true, false, false, false, true]);
  assert.deepEqual(score(firstAlertBaseline), [true, true, true, false, false]);
});

const GOOD = {
  service: 'payment-db',
  kind: 'degrade',
  summary: 'payment-db 지연이 먼저 오르고 위쪽 서비스가 뒤따랐다',
  evidence: [{ step: 1, fact: 'T+65 checkout-api 배포는 지연 상승보다 앞서지만 관련 없음' }],
  ruledOut: [{ service: 'checkout-api', why: '배포 뒤 지표 변화 없음' }],
};

test('도구 결과에 호출 번호를 붙여 다음 턴에 보내고, 제출하면 끝낸다', async () => {
  const ctx = contextFor(load('db-degradation'), 1);
  const { chat, seen } = scripted([[['list_deploys', {}]], [['submit_root_cause', GOOD]]]);
  const r = await investigate(ctx, chat);
  assert.equal(r.stopReason, 'submitted');
  assert.deepEqual(r.verdict, GOOD);
  const tool = seen[1]!.at(-1)!;
  assert.equal(tool.role, 'tool');
  assert.deepEqual(JSON.parse(tool.content!), { step: 1, result: [{ t: 65, service: 'checkout-api', version: 'v3.1.0' }] });
});

test('잘못된 제출은 오류를 돌려주고 고칠 기회를 준다', async () => {
  const ctx = contextFor(load('retry-storm'), 1);
  const { chat, seen } = scripted([
    [['list_alerts', {}]],
    [['submit_root_cause', { ...GOOD, service: 'database' }]],
    [['submit_root_cause', GOOD]],
  ]);
  const r = await investigate(ctx, chat);
  assert.equal(r.verdict?.service, 'payment-db');
  assert.deepEqual(JSON.parse(seen[2]!.at(-1)!.content!), { step: 2, error: 'service 는 checkout-api, payment-api, inventory-api, payment-db 중 하나' });
});

test('제출 검증: 근거는 이미 부른 조사 도구 번호, 글은 한국어, 버린 후보는 원인과 다른 서비스', () => {
  const known = new Set(['checkout-api', 'payment-db']);
  const prior = [{ tool: 'list_alerts' }, { tool: 'submit_root_cause' }, { tool: 'get_logs' }];
  const err = (patch: Record<string, unknown>) => {
    const r = parseVerdict({ ...GOOD, ...patch }, known, prior);
    return r.ok ? 'ok' : r.error;
  };
  assert.deepEqual(
    [
      err({}),
      err({ evidence: [{ step: 3, fact: '로그에 시간 초과' }] }),
      err({ evidence: [{ step: 4, fact: '없는 번호' }] }),
      err({ evidence: [{ step: 2, fact: '제출 시도를 근거로' }] }),
      err({ evidence: [] }),
      err({ summary: 'payment-db latency rose first' }),
      err({ evidence: [{ step: 1, fact: 'p99 spiked' }] }),
      err({ ruledOut: [] }),
      err({ ruledOut: [{ service: 'payment-db', why: '자기 자신' }] }),
      err({ ruledOut: [{ service: 'checkout-api', why: 'deploy unrelated' }] }),
    ],
    [
      'ok',
      'ok',
      'evidence.step 은 이미 부른 조사 도구 번호 (1~3)',
      'evidence.step 은 이미 부른 조사 도구 번호 (1~3)',
      'evidence 는 1~4개 배열',
      'summary 는 한국어 한 문장 (200자 이하)',
      'evidence.fact 는 한국어 한 줄 (200자 이하)',
      'ruledOut 은 버린 후보 1~3개 배열',
      'ruledOut.service 는 원인이 아닌 다른 서비스',
      'ruledOut.why 는 한국어 한 줄 (200자 이하)',
    ],
  );
});

test('도구를 안 부르면 한 번 재촉하고, 또 안 부르면 끝낸다', async () => {
  const { chat, seen } = scripted([[], []]);
  const r = await investigate(contextFor(load('retry-storm'), 1), chat);
  assert.deepEqual([r.stopReason, seen.length], ['no_tool_call', 2]);
});

test('호출 수 상한에서 멈춘다', async () => {
  const { chat } = scripted(Array.from({ length: 20 }, () => [['get_topology', {}]] as [string, Record<string, unknown>][]));
  const r = await investigate(contextFor(load('retry-storm'), 1), chat, { maxSteps: 4 });
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

test('제출 검증: 틀린 칸은 한 번에 모두 알려 준다', () => {
  const r = parseVerdict({ ...GOOD, summary: 'english', ruledOut: [] }, new Set(['checkout-api', 'payment-db']), [{ tool: 'list_alerts' }]);
  assert.deepEqual(r, { ok: false, error: 'summary 는 한국어 한 문장 (200자 이하) / ruledOut 은 버린 후보 1~3개 배열' });
});

test('형식이 틀려 돌려보낸 제출은 조사 횟수에 넣지 않는다 (최대 2번)', async () => {
  const bad = { ...GOOD, summary: 'english only' };
  const look: [string, Record<string, unknown>][] = [['list_deploys', {}]];
  const run = (turns: [string, Record<string, unknown>][][]) => investigate(contextFor(load('db-degradation'), 1), scripted(turns).chat, { maxSteps: 3 });
  // 조사 2번 + 형식 오류 2번 + 제출 = 5번 호출. 상한 3 + 봐주기 2 안에 든다
  const ok = await run([look, look, [['submit_root_cause', bad]], [['submit_root_cause', bad]], [['submit_root_cause', GOOD]]]);
  assert.deepEqual([ok.stopReason, ok.steps.length], ['submitted', 5]);
  // 봐주기는 2번까지. 세 번째 형식 오류는 조사 횟수를 쓴다: 조사 2 + 오류 3 = 5번에서 멈춘다
  const over = await run([look, look, [['submit_root_cause', bad]], [['submit_root_cause', bad]], [['submit_root_cause', bad]], [['submit_root_cause', GOOD]]]);
  assert.deepEqual([over.stopReason, over.steps.length], ['max_steps', 5]);
});

test('평가 단계 기록: 조사 도구는 인자를, 제출은 성공·거부 사유를 한 줄로 남긴다', () => {
  assert.deepEqual(
    [
      traceLine('get_metric', { service: 'payment-db', name: 'latency_p99' }, []),
      traceLine('submit_root_cause', { service: 'x' }, { error: 'summary 는 한국어 한 문장 (200자 이하)' }),
      traceLine('submit_root_cause', { service: 'payment-db', kind: 'degrade' }, { ok: true }),
    ],
    ['get_metric(payment-db, latency_p99)', 'submit_root_cause ✖ summary 는 한국어 한 문장 (200자 이하)', 'submit_root_cause ✔ payment-db/degrade'],
  );
});

test('이전 결과는 같은 코드 버전으로 잰 행만 다시 쓰고, 버전이 다르면 다시 잰다', async () => {
  // 경보 목록을 한 번 보고 바로 결론을 내는 가짜 모델. 부른 횟수를 센다
  let calls = 0;
  const chat: ChatFn = async (messages) => {
    calls++;
    const first = !messages.some((m) => m.role === 'tool');
    const call = first
      ? { name: 'list_alerts', arguments: '{}' }
      : { name: 'submit_root_cause', arguments: JSON.stringify({ service: 'payment-db', kind: 'degrade', summary: '경보를 보고 고름', evidence: [{ step: 1, fact: '경보 목록을 봄' }], ruledOut: [] }) };
    return { role: 'assistant', content: null, tool_calls: [{ id: `c${calls}`, function: call }] };
  };
  const v1 = await evaluate(chat, [1], { version: 'v1' });
  const fresh = calls;
  assert.notEqual(fresh, 0, "가짜 모델을 한 번도 안 불렀다면 아래 비교가 의미 없다");
  assert.deepEqual([v1.length, [...new Set(v1.map((r) => r.version))]], [SCENARIOS.length, ['v1']]);

  const same = await evaluate(chat, [1], { prev: v1, version: 'v1' });
  assert.deepEqual([calls - fresh, same], [0, v1]);

  const other = await evaluate(chat, [1], { prev: v1, version: 'v2' });
  // 가짜 모델은 같은 입력에 같은 순서로 답하므로, 다시 재면 처음과 같은 횟수를 부른다
  assert.deepEqual([calls - fresh, [...new Set(other.map((r) => r.version))]], [fresh, ['v2']]);
});

test('codeVersion 은 파일 내용이 바뀌면 달라지고, 순서가 달라도 같다', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'sd-ver-'));
  try {
    const a = join(dir, 'a.ts');
    const b = join(dir, 'b.ts');
    writeFileSync(a, 'const x = 1;');
    writeFileSync(b, 'const y = 2;');
    const before = codeVersion([a, b]);
    assert.equal(codeVersion([b, a]), before);
    writeFileSync(a, 'const x = 3;');
    assert.notEqual(codeVersion([a, b]), before);
    assert.match(before, /^[0-9a-f]{12}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('정답률 표는 에이전트를 측정하지 못한 건을 규칙 쪽 분모에서도 뺀다', () => {
  const row = (seed: number, measured: boolean): Row => ({
    scenario: 'silent-db', seed, agent: measured ? 'payment-db/degrade' : '오류: 429', agentOk: measured, measured,
    baseline: '-', baselineOk: true, firstAlert: '-', firstAlertOk: true, steps: 3, ms: 1000,
  });
  const line = summarize([row(1, true), row(2, false)]).split('\n').find((l) => l.startsWith('| 전체'))!;
  assert.deepEqual(line.split('|').slice(2, 5).map((c) => c.trim()), ['1/1 (측정 불가 1)', '1/1', '1/1']);
});
