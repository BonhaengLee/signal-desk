import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEvent } from '../src/events/schema.ts';

const valid = {
  v: 1,
  id: 'simulator-42-0',
  seq: 0,
  source: 'simulator',
  service: 'payment-api',
  at: '2026-01-01T00:01:00.000Z',
  type: 'metric',
  payload: { name: 'latency_p99', value: 820, unit: 'ms' },
};

function errorsOf(raw: unknown): string[] {
  const r = parseEvent(raw);
  assert.equal(r.ok, false, '거절돼야 하는 입력이 통과했다');
  return r.ok ? [] : r.errors;
}

test('정상 이벤트는 통과하고 at 문자열이 같은 순간의 Date 로 바뀐다', () => {
  const r = parseEvent(valid);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.event.at instanceof Date);
  assert.equal(r.event.at.toISOString(), '2026-01-01T00:01:00.000Z');
  assert.deepEqual(r.event.payload, { name: 'latency_p99', value: 820, unit: 'ms' });
});

test('알 수 없는 필드는 결과에서 빠진다', () => {
  const r = parseEvent({ ...valid, debug: 'x', payload: { ...valid.payload, extra: 1 } });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(Object.keys(r.event).sort(), ['at', 'id', 'payload', 'seq', 'service', 'source', 'type', 'v']);
  assert.deepEqual(Object.keys(r.event.payload).sort(), ['name', 'unit', 'value']);
});

test('404 에러 본문은 빠진 필드를 전부 이유와 함께 거절한다', () => {
  assert.deepEqual(errorsOf({ message: 'not found' }), [
    'v: 1 이어야 함 (받은 값 undefined)',
    'id: 비어 있지 않은 문자열이어야 함 (받은 값 undefined)',
    'seq: 0 이상의 정수여야 함 (받은 값 undefined)',
    'source: simulator|rcaeval 중 하나여야 함 (받은 값 undefined)',
    'service: 비어 있지 않은 문자열이어야 함 (받은 값 undefined)',
    'at: UTC ISO 문자열이어야 함 (받은 값 undefined)',
    'type: metric|log|deploy|alert 중 하나여야 함 (받은 값 undefined)',
  ]);
});

test('type 오타는 거절하고, type 을 모르면 payload 는 검사하지 않는다', () => {
  assert.deepEqual(errorsOf({ ...valid, type: 'metirc', payload: null }), [
    'type: metric|log|deploy|alert 중 하나여야 함 (받은 값 "metirc")',
  ]);
});

test('Date.parse 가 받아 주는 느슨한 날짜도 거절한다', () => {
  for (const at of ['어제', '1', '2026-01-01', '2026-01-01T00:00:00+09:00']) {
    assert.deepEqual(errorsOf({ ...valid, at }), [`at: UTC ISO 문자열이어야 함 (받은 값 ${JSON.stringify(at)})`], at);
  }
});

test('NaN 이 JSON 을 거쳐 null 이 된 지표 값은 거절한다', () => {
  const wire = JSON.parse(JSON.stringify({ ...valid, payload: { ...valid.payload, value: NaN } }));
  assert.equal(wire.payload.value, null);
  assert.deepEqual(errorsOf(wire), ['payload.value: 유한한 숫자여야 함 (받은 값 null)']);
});

test('type 마다 다른 payload 규칙을 적용한다', () => {
  // metric 모양의 payload 를 log 로 보내면 log 규칙으로 거절된다
  assert.deepEqual(errorsOf({ ...valid, type: 'log' }), [
    'payload.level: info|warn|error 중 하나여야 함 (받은 값 undefined)',
    'payload.message: 비어 있지 않은 문자열이어야 함 (받은 값 undefined)',
  ]);
  // alert 에는 info 등급이 없다
  assert.deepEqual(
    errorsOf({ ...valid, type: 'alert', payload: { level: 'info', rule: 'p99 > 500ms', state: 'firing' } }),
    ['payload.level: warn|error 중 하나여야 함 (받은 값 "info")'],
  );
});

test('seq 는 0 이상의 정수만 받는다', () => {
  for (const seq of [-1, 1.5, '3']) {
    assert.deepEqual(errorsOf({ ...valid, seq }), [`seq: 0 이상의 정수여야 함 (받은 값 ${JSON.stringify(seq)})`]);
  }
});
