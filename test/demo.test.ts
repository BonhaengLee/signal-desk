import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AuditEvent } from '../src/audit/store.ts';
import { demoDecide, demoStart, demoSubscribe, pausableClock, playbackGaps, STEP_MAX_MS, STEP_MIN_MS } from '../src/web/demo.ts';
import { demoEvents } from '../scripts/build-demo.ts';
import { readFileSync } from 'node:fs';

const at = (s: number): AuditEvent => ({ seq: s, at: new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString(), actor: 'agent', kind: 'tool_call', payload: {} });

test('녹화 재생 간격: 실제 간격을 0.5~1.5초 안으로 줄인다', () => {
  // 0초, 0.2초 뒤(→0.5), 1초 뒤, 30초 뒤(→1.5)
  const ev = [at(0), { ...at(0), at: '2026-01-01T00:00:00.200Z' }, at(1), at(31)];
  assert.deepEqual(playbackGaps(ev), [0, STEP_MIN_MS, 800, STEP_MAX_MS]);
});

test('데모 결정도 서버와 같은 규칙: 이름 형식, 거절 사유 필수, 모르는 제안은 404', () => {
  const err = (f: () => void) => {
    try {
      f();
      return 'ok';
    } catch (e) {
      return `${(e as { status: number }).status} ${(e as Error).message}`;
    }
  };
  assert.deepEqual(
    [err(() => demoDecide('p', '김', 'approved')), err(() => demoDecide('p', 'kim', 'rejected', ' ')), err(() => demoDecide('p', 'kim', 'approved'))],
    ['400 operator 는 영문·숫자·._- 1~40자', '400 거절에는 사유가 필요하다', '404 없는 제안'],
  );
});

test('데모 이벤트 파일에는 시나리오 정답과 설명이 들어가지 않는다', () => {
  const s = JSON.parse(readFileSync('scenarios/db-degradation.json', 'utf8'));
  const out = JSON.stringify(demoEvents(s));
  assert.deepEqual([out.includes('rootCause'), out.includes('description'), out.includes(s.description)], [false, false, false]);
});

test('데모 녹화는 녹화 시점 전에 누르면 시작하지 않는다', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, json: async () => ({ 'db-degradation': { id: 'rec-1', atSec: 120 } }) })) as unknown as typeof fetch;
  try {
    const early = await demoStart('db-degradation', 90).catch((e: { status: number; message: string }) => `${e.status} ${e.message}`);
    assert.deepEqual(
      [early, await demoStart('db-degradation', 120), await demoStart('retry-storm', 150).catch((e: { status: number }) => e.status)],
      ['409 데모 녹화는 T+02:00 시점까지의 기록으로 돌린 조사입니다. 재생이 그 시점을 지나면 다시 눌러 주세요', 'rec-1', 404],
    );
  } finally {
    globalThis.fetch = real;
  }
});

test('멈추는 시계: 멈춘 동안 흐른 시간은 세지 않고, 다시 돌면 멈춘 값부터 이어 센다', () => {
  let now = 0;
  let paused = false;
  const clock = pausableClock(() => now, () => paused);
  const read = (ms: number) => ((now = ms), clock());
  // 0→2초 재생, 2→60초 멈춤, 60→61초 재생
  const a = read(2000);
  paused = true;
  const b = read(60_000);
  paused = false;
  const c = read(61_000);
  assert.deepEqual([a, b, c], [2, 2, 3]);
});

test('데모 재생은 멈춘 동안 이벤트를 내보내지 않고, 풀면 그 자리부터 이어 보낸다', async () => {
  const realFetch = globalThis.fetch;
  const g = globalThis as { location?: unknown };
  const realLocation = g.location;
  // 1초마다 이벤트 하나, 10초짜리 시나리오
  const events = Array.from({ length: 10 }, (_, i) => ({ simSec: i, event: { seq: i } }));
  globalThis.fetch = (async () => ({ ok: true, json: async () => ({ durationSec: 10, events }) })) as unknown as typeof fetch;
  g.location = { origin: 'http://demo.test' };
  const ac = new AbortController();
  const got: string[] = [];
  let paused = true;
  const done = demoSubscribe('/events?scenario=x&speed=20', { signal: ac.signal, onMessage: (m) => got.push(m.event === 'reset' ? 'reset' : m.id!) }, () => paused);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    await sleep(350); // 멈추지 않았다면 20배속으로 7초어치가 지나간다
    const whilePaused = [...got];
    paused = false;
    await sleep(250); // 약 5초어치
    assert.deepEqual(whilePaused, ['0:0']);
    assert.equal(got[1], '0:1'); // 멈춘 동안 건너뛴 구간 없이 1초 이벤트부터 이어진다
    assert.equal(got.includes('reset'), false);
  } finally {
    ac.abort();
    await done;
    globalThis.fetch = realFetch;
    g.location = realLocation;
  }
});
