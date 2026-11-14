import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AuditEvent } from '../src/audit/store.ts';
import { demoDecide, demoReadyAt, demoSeek, demoStart, demoSubscribe, pausableClock, playbackGaps, STEP_MAX_MS, STEP_MIN_MS } from '../src/web/demo.ts';
import { demoEvents } from '../scripts/build-demo.ts';
import { readFileSync } from 'node:fs';

const JSON_HEADERS = new Headers({ 'content-type': 'application/json' });
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
  globalThis.fetch = (async () => ({ ok: true, headers: JSON_HEADERS, json: async () => ({ 'db-degradation': { id: 'rec-1', atSec: 120 } }) })) as unknown as typeof fetch;
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
  const read = (ms: number) => ((now = ms), clock.read());
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
  globalThis.fetch = (async () => ({ ok: true, headers: JSON_HEADERS, json: async () => ({ durationSec: 10, events }) })) as unknown as typeof fetch;
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

test('데모 조사 주소가 uuid 모양이 아니면 시나리오 재생으로 빠지지 않고 404 로 끝난다', async () => {
  const realFetch = globalThis.fetch;
  const g = globalThis as { location?: unknown };
  const realLocation = g.location;
  let fetched = 0;
  globalThis.fetch = (async () => (fetched++, { ok: true, headers: JSON_HEADERS, json: async () => ({ durationSec: 10, events: [] }) })) as unknown as typeof fetch;
  g.location = { origin: 'http://demo.test' };
  try {
    // 시간 제한: 재생 루프로 빠지면 끝나지 않으므로 200ms 뒤 끊어 'resolved' 로 드러나게 한다
    const result = await demoSubscribe('/investigations/not-a-uuid/stream', { signal: AbortSignal.timeout(200), onMessage: () => {} }, () => false).then(
      () => 'resolved',
      (e: { status: number }) => `rejected ${e.status}`,
    );
    assert.deepEqual([result, fetched], ['rejected 404', 0]);
  } finally {
    globalThis.fetch = realFetch;
    g.location = realLocation;
  }
});

test('없는 데모 파일에 index.html 을 200 으로 주는 호스트에서도 404 로 본다', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, headers: new Headers({ 'content-type': 'text/html' }), json: async () => JSON.parse('<!doctype html>') })) as unknown as typeof fetch;
  try {
    const result = await demoStart('db-degradation', 999).catch((e: { status: number }) => e.status);
    assert.equal(result, 404);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('데모 녹화 시점은 녹화 목록(index.json)에서 읽고, 녹화가 없으면 undefined', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, headers: JSON_HEADERS, json: async () => ({ 'db-degradation': { id: 'rec-1', atSec: 95 } }) })) as unknown as typeof fetch;
  try {
    assert.deepEqual([await demoReadyAt('db-degradation'), await demoReadyAt('retry-storm')], [95, undefined]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('끝까지 본 조사 녹화는 다시 열면 간격 없이 바로 보낸다 (시나리오를 바꿨다 돌아온 경우)', async () => {
  const realFetch = globalThis.fetch;
  const g = globalThis as { location?: unknown };
  const realLocation = g.location;
  const id = '11111111-1111-4111-8111-111111111111';
  const events = [at(0), at(1), at(2)].map((e, i) => ({ ...e, seq: i + 1 }));
  globalThis.fetch = (async () => ({ ok: true, headers: JSON_HEADERS, json: async () => ({ id, scenario: 'x', events }) })) as unknown as typeof fetch;
  g.location = { origin: 'http://demo.test' };
  // 3건을 다 받으면 끊고 걸린 시간을 잰다
  const play = async () => {
    const ac = new AbortController();
    let got = 0;
    const t0 = performance.now();
    await demoSubscribe(`/investigations/${id}/stream`, { signal: ac.signal, onMessage: () => ++got === events.length && ac.abort() }, () => false);
    return [got, performance.now() - t0] as const;
  };
  try {
    const [firstGot, firstMs] = await play();
    const [againGot, againMs] = await play();
    assert.deepEqual([firstGot, againGot], [3, 3]);
    assert.ok(firstMs >= 2 * STEP_MIN_MS, `처음은 간격을 둔다: ${firstMs}ms`);
    assert.ok(againMs < STEP_MIN_MS, `다시 열면 바로: ${againMs}ms`);
  } finally {
    globalThis.fetch = realFetch;
    g.location = realLocation;
  }
});

test('재생 위치 옮기기: 멈춰 있어도 그 시점까지의 이벤트를 한 건으로 보내고, 멈춘 동안은 더 보내지 않는다', async () => {
  const realFetch = globalThis.fetch;
  const g = globalThis as { location?: unknown };
  const realLocation = g.location;
  const events = Array.from({ length: 10 }, (_, i) => ({ simSec: i * 10, event: { seq: i } }));
  globalThis.fetch = (async () => ({ ok: true, headers: JSON_HEADERS, json: async () => ({ durationSec: 100, events }) })) as unknown as typeof fetch;
  g.location = { origin: 'http://demo.test' };
  const ac = new AbortController();
  const got: { event: string; data?: string; id?: string }[] = [];
  let paused = true;
  const done = demoSubscribe('/events?scenario=x&speed=20', { signal: ac.signal, onMessage: (m) => got.push(m) }, () => paused);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    await sleep(150);
    demoSeek(45);
    await sleep(350);
    const snap = got.filter((m) => m.event === 'snapshot');
    assert.deepEqual(
      [snap.length, JSON.parse(snap[0]!.data!).map((e: { seq: number }) => e.seq), got.at(-1)!.event],
      [1, [0, 1, 2, 3, 4], 'snapshot'], // 0~40초 이벤트. 멈춰 있으니 그 뒤로 더 오지 않는다
    );
    paused = false;
    await sleep(400); // 20배속으로 약 8초어치: 45초에서 이어지면 50초 이벤트만 오고 60초 이벤트는 아직이다
    assert.deepEqual(
      got.slice(got.findIndex((m) => m.event === 'snapshot') + 1).map((m) => m.id), // 옮긴 뒤에 온 것만 (0초 이벤트는 옮기기 전에 나갔다)
      ['0:5'],
    );
  } finally {
    ac.abort();
    await done;
    globalThis.fetch = realFetch;
    g.location = realLocation;
  }
});
