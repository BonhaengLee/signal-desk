import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AuditEvent } from '../src/audit/store.ts';
import { formatCall, formatResult, parseAuditEvent, previewResult, startBlockedReason, summarizeInvestigation } from '../src/web/investigation.ts';

const ev = (seq: number, kind: AuditEvent['kind'], payload: unknown, actor: AuditEvent['actor'] = 'agent'): AuditEvent => ({
  seq,
  at: `2026-11-10T00:00:${String(seq).padStart(2, '0')}Z`,
  actor,
  kind,
  payload,
});

const base = [
  ev(1, 'investigation_started', { scenario: 'silent-db', seed: 42, model: 'm' }, 'system'),
  ev(2, 'tool_call', { tool: 'list_alerts', args: {}, result: [{ service: 'payment-api' }] }),
  ev(3, 'tool_call', { tool: 'get_logs', args: { service: 'payment-api' }, result: [] }),
  ev(4, 'verdict', { service: 'payment-db', kind: 'degrade', summary: 'payment-db 가 먼저 느려졌다', evidence: [{ step: 2, fact: '로그가 payment-db 시간 초과를 가리킴' }], ruledOut: [{ service: 'payment-api', why: '증상만 보임' }] }),
  ev(5, 'proposal', { proposalId: 'p1', action: { type: 'escalate', service: 'payment-db' } }),
];

test('조사 → 결론 → 제안까지 오면 승인 대기 상태이고 단계는 도구 호출 순서대로다', () => {
  const v = summarizeInvestigation(base);
  assert.equal(v.phase, 'proposed');
  assert.deepEqual([v.scenario, v.seed, v.model], ['silent-db', 42, 'm']);
  assert.deepEqual(v.steps.map((s) => s.tool), ['list_alerts', 'get_logs']);
  assert.deepEqual(v.verdict, { service: 'payment-db', kind: 'degrade', summary: 'payment-db 가 먼저 느려졌다', evidence: [{ step: 2, fact: '로그가 payment-db 시간 초과를 가리킴' }], ruledOut: [{ service: 'payment-api', why: '증상만 보임' }] });
  assert.deepEqual(v.proposal, { id: 'p1', action: { type: 'escalate', service: 'payment-db' }, status: 'pending' });
});

test('재연결로 같은 이벤트가 다시 오거나 순서가 섞여도 결과가 같다', () => {
  const shuffled = [base[4]!, base[1]!, base[0]!, base[1]!, base[3]!, base[2]!, base[4]!];
  assert.deepEqual(summarizeInvestigation(shuffled), summarizeInvestigation(base));
});

test('거절은 결정자와 사유를, 승인 뒤 실행은 실행됨 상태를 남긴다', () => {
  const rejected = summarizeInvestigation([...base, ev(6, 'decision', { proposalId: 'p1', from: 'pending', to: 'rejected', reason: '근거 부족' }, 'operator:kim')]);
  assert.equal(rejected.phase, 'decided');
  assert.deepEqual(rejected.proposal, { id: 'p1', action: { type: 'escalate', service: 'payment-db' }, status: 'rejected', decidedBy: 'kim', reason: '근거 부족' });

  const executed = summarizeInvestigation([
    ...base,
    ev(6, 'decision', { proposalId: 'p1', from: 'pending', to: 'approved' }, 'operator:lee'),
    ev(7, 'execution', { proposalId: 'p1', from: 'approved', to: 'executed' }, 'system'),
  ]);
  assert.deepEqual([executed.phase, executed.proposal?.status, executed.proposal?.decidedBy], ['decided', 'executed', 'lee']);
});

test('다른 제안의 결정은 반영하지 않는다', () => {
  const v = summarizeInvestigation([...base, ev(6, 'decision', { proposalId: 'other', from: 'pending', to: 'approved' }, 'operator:kim')]);
  assert.deepEqual([v.phase, v.proposal?.status], ['proposed', 'pending']);
});

test('결론을 못 내면 실패 사유를 보여 준다', () => {
  const v = summarizeInvestigation([base[0]!, base[1]!, ev(3, 'investigation_failed', { reason: 'max_steps', steps: 10 }, 'system')]);
  assert.deepEqual([v.phase, v.failure, v.steps.length], ['failed', 'max_steps', 1]);
});

test('SSE data 검증: 모양이 다르면 버린다', () => {
  assert.deepEqual(parseAuditEvent(JSON.stringify(base[1])), base[1]);
  assert.deepEqual(['', '{', '[]', '{"seq":"1","kind":"x","actor":"a","at":"t"}', undefined].map(parseAuditEvent), [undefined, undefined, undefined, undefined, undefined]);
});

test('도구 호출 한 줄 요약과 결과 미리 보기', () => {
  assert.equal(formatCall({ tool: 'get_metric', args: { service: 'payment-api', metric: 'latency_p99' } }), 'get_metric(service: payment-api, metric: latency_p99)');
  assert.deepEqual(
    [previewResult([1, 2, 3]), previewResult({ error: '모르는 서비스' }), previewResult({ a: 'x'.repeat(200) }, 20)],
    ['3건', '오류: 모르는 서비스', '{"a":"xxxxxxxxxxxxx…'],
  );
});

test('이전 형식(근거가 문자열 하나)으로 남은 감사 로그도 읽는다', () => {
  const v = summarizeInvestigation([base[0]!, ev(2, 'verdict', { service: 'payment-api', kind: 'deploy', evidence: 'T+60 배포 직후 상승' })]);
  assert.deepEqual(v.verdict, { service: 'payment-api', kind: 'deploy', summary: '', evidence: [{ step: 0, fact: 'T+60 배포 직후 상승' }], ruledOut: [] });
});

test('펼친 결과: 배열은 항목 하나를 한 줄로, 지표 표는 열 하나를 한 줄로', () => {
  assert.equal(formatResult([{ t: 0, max: 405 }, { t: 10, max: 402 }]), '[\n  {"t":0,"max":405},\n  {"t":10,"max":402}\n]');
  assert.equal(formatResult({ t: [0, 30], cpu: [1.1, 90] }), '{\n  "t": [0,30],\n  "cpu": [1.1,90]\n}');
  assert.equal(formatResult({ ok: true }), '{\n  "ok": true\n}');
});

test('조사 시작 기록의 atSec 을 보여 준다 (없으면 전체 기록)', () => {
  const at = summarizeInvestigation([ev(1, 'investigation_started', { scenario: 'silent-db', seed: 42, model: 'm', atSec: 120 }, 'system')]);
  assert.deepEqual([at.atSec, summarizeInvestigation(base).atSec], [120, undefined]);
});

test('조사 버튼: 승인 대기 제안, 경보 전, 녹화 정보 읽는 중, 녹화 없음, 녹화 시점 전에는 끄고 이유를 준다', () => {
  const at = (alerted: boolean, nowSec: number, readyAt: number | null | undefined, pendingProposal = false) => startBlockedReason({ alerted, nowSec, readyAt, pendingProposal });
  assert.deepEqual(
    [
      at(true, 200, 0, true),
      at(false, 200, 0, true), // 처음으로 돌아가 경보가 없어도 대기 제안이 먼저
      at(false, 200, 0),
      at(true, 200, undefined),
      at(true, 200, null),
      at(true, 119, 120),
      at(true, 120, 120),
      at(true, 5, 0), // 서버 모드: 경보만 울리면 언제든
    ],
    [
      '승인 대기 중인 제안을 먼저 승인하거나 거절하세요',
      '승인 대기 중인 제안을 먼저 승인하거나 거절하세요',
      '경보가 울리면 조사할 수 있습니다',
      '데모 녹화 정보를 불러오는 중입니다',
      '이 시나리오는 데모 녹화를 찾지 못했습니다',
      'T+02:00부터 누를 수 있습니다',
      undefined,
      undefined,
    ],
  );
});
