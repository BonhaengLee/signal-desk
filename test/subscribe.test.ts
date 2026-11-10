import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { backoffDelay, order, subscribe, type SubscribeStatus } from '../src/client/subscribe.ts';
import { ANCHOR_MS, createSseServer } from '../src/server/sse.ts';
import type { SseMessage } from '../src/client/sse.ts';

const noSleep = async () => {};

test('backoffDelay: 1s, 2s, 4s … 상한 15s', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((a) => backoffDelay(a, 1000, 15_000)), [1000, 2000, 4000, 8000, 15_000, 15_000]);
});

test('서버가 연결을 끊어도 다시 붙어 빠짐도 중복도 없이 이어 받는다', async () => {
  // 시계를 빠르게 돌려 이벤트가 조금씩 흘러오게 한다 (실제 5ms 마다 시나리오 1초)
  const clock = { t: ANCHOR_MS };
  const ticker = setInterval(() => (clock.t += 1000), 5);
  const server = createSseServer({ clock: { now: () => clock.t }, tickMs: 2 });
  await new Promise<void>((r) => server.listen(0, r));
  const url = `http://localhost:${(server.address() as AddressInfo).port}/events`;
  const ac = new AbortController();
  const ids: string[] = [];
  const lastEventIds: (string | undefined)[] = [];
  server.on('request', (req) => lastEventIds.push(req.headers['last-event-id'] as string | undefined));
  const statuses: SubscribeStatus[] = [];
  const resumeFrom: (string | undefined)[] = []; // 끊긴 순간 마지막으로 받은 id
  let cuts = 0;

  const done = subscribe(url, {
    signal: ac.signal,
    sleep: noSleep,
    onStatus: (s) => {
      statuses.push(s);
      if (s === 'reconnecting') resumeFrom.push(ids.at(-1));
    },
    onMessage: (m: SseMessage) => {
      ids.push(m.id!);
      // 20건, 50건째에 서버 쪽에서 연결을 강제로 끊는다
      if ((ids.length === 20 || ids.length === 50) && cuts < 2) {
        cuts++;
        server.closeAllConnections();
      }
      if (ids.length === 80) ac.abort();
    },
  });
  await done;
  clearInterval(ticker);
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));

  assert.deepEqual(ids, Array.from({ length: 80 }, (_, i) => `0:${i}`));
  assert.equal(cuts, 2);
  // 첫 요청은 Last-Event-ID 없이, 다시 붙을 때는 끊긴 순간 마지막으로 받은 id 를 보낸다
  // (끊는 시점에 이미 받아 둔 조각이 있으면 그것까지 처리한 뒤라 20·50번째보다 뒤일 수 있다)
  assert.equal(resumeFrom.length, 2);
  assert.deepEqual(lastEventIds.slice(0, 3), [undefined, ...resumeFrom]);
  assert.deepEqual(statuses.filter((s, i) => s !== statuses[i - 1]).slice(0, 5), ['connecting', 'open', 'reconnecting', 'open', 'reconnecting']);
  assert.equal(statuses.at(-1), 'closed');
});

test('서버가 이미 받은 메시지를 다시 보내도 화면으로 넘기지 않는다', async () => {
  // Last-Event-ID 를 무시하고 매번 처음부터 보내는 서버
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('id: 0:0\ndata: a\n\nid: 0:1\ndata: b\n\n');
    if (requests === 1) res.end();
    else res.write('id: 0:2\ndata: c\n\n');
  });
  await new Promise<void>((r) => server.listen(0, r));
  const ac = new AbortController();
  const got: string[] = [];
  await subscribe(`http://localhost:${(server.address() as AddressInfo).port}`, {
    signal: ac.signal,
    sleep: noSleep,
    onMessage: (m) => {
      got.push(m.data!);
      if (m.data === 'c') ac.abort();
    },
  });
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  assert.deepEqual(got, ['a', 'b', 'c']);
});

test('HTTP 오류면 백오프를 늘려 가며 다시 시도하고, 메시지를 받으면 처음 대기로 돌아간다', async () => {
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests++;
    if (requests <= 3) return res.writeHead(503).end();
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('id: 0:0\ndata: ok\n\n');
  });
  await new Promise<void>((r) => server.listen(0, r));
  const ac = new AbortController();
  const delays: number[] = [];
  await subscribe(`http://localhost:${(server.address() as AddressInfo).port}`, {
    signal: ac.signal,
    sleep: async (ms) => {
      delays.push(ms);
      if (delays.length === 5) ac.abort();
    },
    onMessage: () => {},
  });
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  // 503 세 번: 1s, 2s, 4s → 4번째 성공 후 끊김: 다시 1s → 5번째 요청은 같은 응답을 다시 받으므로(중복 거름) 1s
  assert.deepEqual(delays, [1000, 2000, 4000, 1000, 1000]);
});

test('하트비트조차 오지 않는 연결은 끊고 다시 붙는다 (프록시가 끊김을 숨기는 경우)', async () => {
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(requests === 1 ? 'id: 0:0\ndata: first\n\n' : 'id: 0:1\ndata: second\n\n');
    // 그다음엔 아무것도 보내지 않고 연결도 닫지 않는다
  });
  await new Promise<void>((r) => server.listen(0, r));
  const ac = new AbortController();
  const got: string[] = [];
  await subscribe(`http://localhost:${(server.address() as AddressInfo).port}`, {
    signal: ac.signal,
    sleep: noSleep,
    idleTimeoutMs: 50,
    onMessage: (m) => {
      got.push(m.data!);
      if (got.length === 2) ac.abort();
    },
  });
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  assert.deepEqual(got, ['first', 'second']);
  assert.equal(requests, 2);
});

test('조사 스트림처럼 id 가 숫자 하나여도 이어 받기와 중복 거르기가 된다', () => {
  assert.deepEqual(['0:7', '12', 'abc', undefined].map(order), [[0, 7], [0, 12], undefined, undefined]);
});
