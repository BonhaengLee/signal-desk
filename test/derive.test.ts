import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AlertLevel, SignalEvent } from '../src/events/schema.ts';
import { activeSpansAt, buildTimeline, latestFiring } from '../src/web/derive.ts';

const ORIGIN = Date.UTC(2026, 0, 1);
let seq = 0;
const alert = (sec: number, service: string, level: AlertLevel, state: 'firing' | 'resolved'): SignalEvent => ({
  v: 1,
  id: `t-${++seq}`,
  seq,
  source: 'simulator',
  service,
  at: new Date(ORIGIN + sec * 1000),
  type: 'alert',
  payload: { level, rule: 'latency_p99 > 500ms', state },
});

// payment-db: T+60 warn → T+70 error 로 상승 → T+90 해소. checkout-api: T+65 warn 진행 중
const events = [
  alert(60, 'payment-db', 'warn', 'firing'),
  alert(65, 'checkout-api', 'warn', 'firing'),
  alert(70, 'payment-db', 'error', 'firing'),
  alert(90, 'payment-db', 'error', 'resolved'),
];

test('등급이 올라도 경보는 1건으로 세고, 구간은 색을 나누려고 둘로 나눈다', () => {
  const t = buildTimeline(events, ORIGIN);
  assert.equal(t.alerts, 2);
  assert.deepEqual(
    t.spans.map((s) => [s.service, s.level, s.from, s.to, s.open, s.escalated]),
    [
      ['payment-db', 'warn', 60, 70, false, true],
      ['checkout-api', 'warn', 65, 90, true, false],
      ['payment-db', 'error', 70, 90, false, false],
    ],
  );
});

test('울리는 중인 경보의 since 는 등급이 올라도 처음 울린 시각이고, 등급은 최신을 따른다', () => {
  const before = latestFiring(events.slice(0, 3));
  assert.deepEqual(
    [...before.values()].map((a) => [a.service, a.payload.level, (a.since.getTime() - ORIGIN) / 1000]),
    [
      ['checkout-api', 'warn', 65],
      ['payment-db', 'error', 60],
    ],
  );
  assert.deepEqual([...latestFiring(events).keys()], ['checkout-api']);
});

test('등급이 오른 순간에는 새 구간만 잡힌다 (닫힌 구간은 끝 시각을 포함하지 않음)', () => {
  const { spans } = buildTimeline(events, ORIGIN);
  const at = (sec: number) => activeSpansAt(spans, sec).map((s) => `${s.service}:${s.level}`);
  assert.deepEqual(at(70), ['checkout-api:warn', 'payment-db:error']);
  assert.deepEqual(at(69), ['payment-db:warn', 'checkout-api:warn']);
  // 열린 구간은 지금(마지막 이벤트)까지 포함한다
  assert.deepEqual(at(90), ['checkout-api:warn']);
});
