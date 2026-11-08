import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { ANCHOR_MS, createSseServer, formatSse, parseLastEventId, positionAt } from '../src/server/sse.ts';
import { simulate, type Scenario } from '../src/simulator/simulate.ts';

const scenario = JSON.parse(readFileSync(new URL('../scenarios/deploy-regression.json', import.meta.url), 'utf8')) as Scenario;
const events = [...simulate(scenario, 42)];
const simSec = (i: number) => (events[i]!.at.getTime() - Date.parse(scenario.startAt)) / 1000;
const countUpTo = (sec: number) => events.filter((_, i) => simSec(i) <= sec).length;

// 테스트 전용 간이 해석기: 메시지를 빈 줄로 나누고 필드를 읽는다 (제품용 파서는 따로 만든다)
type Msg = { id?: string; event?: string; data?: string; comment?: string; retry?: string };
function parseBlocks(text: string): Msg[] {
  return text
    .split('\n\n')
    .filter((b) => b.length > 0)
    .map((block) => {
      const msg: Msg = {};
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) msg.comment = line.slice(1).trim();
        else {
          const [k, ...rest] = line.split(': ');
          (msg as Record<string, string>)[k!] = rest.join(': ');
        }
      }
      return msg;
    });
}

async function withServer(clock: { t: number }, fn: (base: string) => Promise<void>, heartbeatMs = 60_000) {
  const server = createSseServer({ clock: { now: () => clock.t }, tickMs: 5, heartbeatMs });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    await fn(base);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/** until 이 참이 될 때까지 스트림을 읽고 연결을 끊는다 */
async function readStream(url: string, until: (msgs: Msg[]) => boolean, headers: Record<string, string> = {}): Promise<Msg[]> {
  const ac = new AbortController();
  const res = await fetch(url, { headers, signal: ac.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    const complete = text.slice(0, text.lastIndexOf('\n\n') + 2);
    if (until(parseBlocks(complete))) {
      ac.abort();
      return parseBlocks(complete);
    }
  }
  ac.abort();
  throw new Error(`시간 안에 조건을 만족하지 못함. 받은 내용 앞부분: ${text.slice(0, 300)}`);
}

const signals = (msgs: Msg[]) => msgs.filter((m) => m.event === 'signal');

test('formatSse: 여러 줄 데이터는 줄마다 data: 를 붙이고 빈 줄로 끝낸다', () => {
  assert.equal(formatSse({ id: '0:1', event: 'signal', data: 'a\nb' }), 'id: 0:1\nevent: signal\ndata: a\ndata: b\n\n');
});

test('parseLastEventId: cycle:seq 형식만 받는다', () => {
  assert.deepEqual(parseLastEventId('3:120'), { cycle: 3, seq: 120 });
  for (const bad of ['', '12', '1:-1', 'a:b', '1:2:3', null, undefined]) assert.equal(parseLastEventId(bad), undefined, String(bad));
});

test('positionAt: 시나리오 길이를 넘으면 다음 바퀴로 넘어간다', () => {
  assert.deepEqual(positionAt(ANCHOR_MS + 60_000, 1, 180), { cycle: 0, simSec: 60 });
  assert.deepEqual(positionAt(ANCHOR_MS + 200_000, 1, 180), { cycle: 1, simSec: 20 });
  assert.deepEqual(positionAt(ANCHOR_MS + 10_000, 5, 180), { cycle: 0, simSec: 50 });
});

test('처음 접속하면 지금 시각까지의 이벤트를 한꺼번에 받고, 시간이 흐르면 새 이벤트가 이어진다', async () => {
  const clock = { t: ANCHOR_MS + 60_000 };
  await withServer(clock, async (base) => {
    const backlog = countUpTo(60);
    const later = countUpTo(70);
    assert.ok(later > backlog);
    const msgs = await readStream(`${base}/events?scenario=deploy-regression`, (m) => {
      if (signals(m).length === backlog) clock.t = ANCHOR_MS + 70_000; // 밀린 것을 다 받으면 시계를 10초 돌린다
      return signals(m).length >= later;
    });
    assert.equal(msgs[0]!.retry, '2000');
    const got = signals(msgs);
    assert.deepEqual(got.map((m) => m.id), events.slice(0, later).map((e) => `0:${e.seq}`));
    assert.deepEqual(JSON.parse(got[0]!.data!), JSON.parse(JSON.stringify(events[0])));
  });
});

test('Last-Event-ID 로 다시 붙으면 그다음 이벤트부터 받고 이미 받은 것은 다시 오지 않는다', async () => {
  const clock = { t: ANCHOR_MS + 60_000 };
  await withServer(clock, async (base) => {
    const msgs = await readStream(`${base}/events`, (m) => signals(m).length >= countUpTo(60) - 11, { 'Last-Event-ID': '0:10' });
    assert.deepEqual(signals(msgs).map((m) => m.id), events.slice(11, countUpTo(60)).map((e) => `0:${e.seq}`));
  });
});

test('끊긴 사이에 시나리오가 한 바퀴 돌았으면 reset 을 먼저 보내고 새 바퀴를 처음부터 보낸다', async () => {
  const clock = { t: ANCHOR_MS + 200_000 }; // cycle 1, 20초
  await withServer(clock, async (base) => {
    const msgs = await readStream(`${base}/events`, (m) => signals(m).length >= countUpTo(20), { 'Last-Event-ID': '0:50' });
    const kinds = msgs.filter((m) => m.event).map((m) => m.event);
    assert.equal(kinds[0], 'reset');
    assert.deepEqual(signals(msgs).map((m) => m.id), events.slice(0, countUpTo(20)).map((e) => `1:${e.seq}`));
  });
});

test('조용할 때도 하트비트 주석을 보낸다', async () => {
  const clock = { t: ANCHOR_MS }; // 0초. 0초 이벤트를 보낸 뒤로는 시계가 멈춰 있다
  await withServer(
    clock,
    async (base) => {
      const msgs = await readStream(`${base}/events`, (m) => m.some((x) => x.comment === 'ping'));
      assert.deepEqual(msgs.filter((m) => m.comment).map((m) => m.comment).slice(0, 1), ['ping']);
    },
    20,
  );
});

test('목록에 없는 시나리오·경로 조작·잘못된 인자는 스트림을 열지 않는다', async () => {
  await withServer({ t: ANCHOR_MS }, async (base) => {
    for (const q of ['scenario=nope', 'scenario=../package', 'scenario=%2E%2E%2Fpackage']) {
      assert.equal((await fetch(`${base}/events?${q}`)).status, 404, q);
    }
    for (const q of ['seed=1.5', 'speed=0', 'speed=1000', 'speed=abc']) {
      assert.equal((await fetch(`${base}/events?${q}`)).status, 400, q);
    }
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  });
});
