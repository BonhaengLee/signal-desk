import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SignalEvent } from '../src/events/schema.ts';
import { EMPTY_HELD, holdMessage, releaseHeld, type Held } from '../src/web/useSignalStream.ts';

const ev = (seq: number): SignalEvent => ({
  v: 1,
  id: `simulator-42-${seq}`,
  seq,
  source: 'simulator',
  service: 'payment-api',
  at: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)),
  type: 'metric',
  payload: { name: 'latency_p99', value: 100 + seq, unit: 'ms' },
});

const holdAll = (msgs: Parameters<typeof holdMessage>[1][]): Held => msgs.reduce(holdMessage, EMPTY_HELD);
const seqs = (events: readonly SignalEvent[]) => events.map((e) => e.seq);

test('멈춘 동안 온 이벤트는 순서대로 쌓였다가 재생하면 화면 이벤트 뒤에 붙는다', () => {
  const held = holdAll([{ event: ev(3) }, { event: ev(4) }]);
  assert.deepEqual({ reset: held.reset, seqs: seqs(held.events) }, { reset: false, seqs: [3, 4] });
  assert.deepEqual(seqs(releaseHeld([ev(1), ev(2)], held)), [1, 2, 3, 4]);
});

test('멈춘 동안 시나리오가 처음으로 돌아가면 그 전 버퍼와 화면 이벤트를 버리고 reset 뒤 것만 남긴다', () => {
  const held = holdAll([{ event: ev(7) }, { event: ev(8) }, { reset: true }, { event: ev(0) }, { event: ev(1) }]);
  assert.deepEqual({ reset: held.reset, seqs: seqs(held.events) }, { reset: true, seqs: [0, 1] });
  assert.deepEqual(seqs(releaseHeld([ev(5), ev(6)], held)), [0, 1]);
});

test('reset 이 두 번 와도 버퍼는 마지막 바퀴 것만 가진다', () => {
  const held = holdAll([{ event: ev(1) }, { reset: true }, { event: ev(2) }, { reset: true }, { event: ev(3) }]);
  assert.deepEqual(seqs(held.events), [3]);
});

test('reset 만 오고 이벤트가 없으면 재생할 때 화면을 비운다', () => {
  assert.deepEqual(releaseHeld([ev(1)], holdAll([{ reset: true }])), []);
});

test('버퍼가 비었으면 같은 배열을 돌려준다 (리렌더 없음)', () => {
  const current = [ev(1)];
  assert.equal(releaseHeld(current, EMPTY_HELD), current);
});

test('버퍼에 넣는 함수는 이전 버퍼를 바꾸지 않는다', () => {
  const before = holdAll([{ event: ev(1) }]);
  holdMessage(before, { event: ev(2) });
  holdMessage(before, { reset: true });
  assert.deepEqual({ reset: before.reset, seqs: seqs(before.events) }, { reset: false, seqs: [1] });
});
