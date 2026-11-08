import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { connect, parseMessage, splitMessages, type SseMessage } from '../src/client/sse.ts';
import { ANCHOR_MS, createSseServer } from '../src/server/sse.ts';

test('parseMessage: 이름표, 기본값 message, 여러 줄 data, 주석', () => {
  assert.deepEqual(parseMessage('id: 0:1\nevent: signal\ndata: {"a":1}'), { event: 'signal', id: '0:1', data: '{"a":1}' });
  assert.deepEqual(parseMessage('event: reset\ndata: {"cycle":1}'), { event: 'reset', data: '{"cycle":1}' });
  assert.deepEqual(parseMessage('id: 0:2\ndata: 첫줄\ndata: 둘째줄'), { event: 'message', id: '0:2', data: '첫줄\n둘째줄' });
  assert.deepEqual(parseMessage(': ping'), { event: 'message' });
});

test('splitMessages: 마지막 칸은 항상 rest', () => {
  assert.deepEqual(splitMessages(''), { blocks: [], rest: '' });
  assert.deepEqual(splitMessages('id: 0:2\nda'), { blocks: [], rest: 'id: 0:2\nda' });
  assert.deepEqual(splitMessages('data: a\n\n'), { blocks: ['data: a'], rest: '' });
  assert.deepEqual(splitMessages('data: a\n\ndata: b\n\nid: 0:3'), { blocks: ['data: a', 'data: b'], rest: 'id: 0:3' });
});

/** 정해 둔 바이트 조각을 그대로 흘려보내는 서버 */
async function withChunks(chunks: Uint8Array[], fn: (url: string) => Promise<void>) {
  const server = http.createServer(async (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const c of chunks) {
      res.write(c);
      await new Promise((r) => setTimeout(r, 5)); // 조각이 따로 도착하도록 간격을 둔다
    }
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, r));
  try {
    await fn(`http://localhost:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test('connect: 메시지와 한글 글자가 조각 경계에서 잘려 와도 그대로 복원한다', async () => {
  const text = ': ping\n\nid: 0:1\nevent: signal\ndata: 장애 발생\n\nevent: reset\ndata: {"cycle":1}\n\n';
  const bytes = new TextEncoder().encode(text);
  const cut = text.indexOf('장') + 1; // '장'(3바이트)의 첫 바이트 뒤에서 자른다 ('장' 앞은 모두 1바이트 글자)
  assert.equal(new TextDecoder().decode(bytes.slice(cut - 1, cut + 2)), '장');
  const chunks = [bytes.slice(0, 20), bytes.slice(20, cut), bytes.slice(cut, cut + 9), bytes.slice(cut + 9)];
  const got: SseMessage[] = [];
  await withChunks(chunks, (url) => connect(url, (m) => got.push(m)));
  assert.deepEqual(got, [
    { event: 'signal', id: '0:1', data: '장애 발생' },
    { event: 'reset', data: '{"cycle":1}' },
  ]);
});

test('connect: 실제 SSE 서버의 이벤트를 받아 JSON 으로 읽는다', async () => {
  const server = createSseServer({ clock: { now: () => ANCHOR_MS + 60_000 }, tickMs: 5 });
  await new Promise<void>((r) => server.listen(0, r));
  const ac = new AbortController();
  const got: SseMessage[] = [];
  try {
    await connect(
      `http://localhost:${(server.address() as AddressInfo).port}/events?scenario=deploy-regression`,
      (m) => {
        got.push(m);
        if (got.length === 30) ac.abort();
      },
      { signal: ac.signal },
    ).catch((e) => {
      if (e.name !== 'AbortError') throw e;
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
  assert.equal(got.length, 30);
  assert.deepEqual(got.map((m) => m.event), Array(30).fill('signal'));
  assert.deepEqual(got.map((m) => m.id), got.map((_, i) => `0:${i}`));
  assert.deepEqual(Object.keys(JSON.parse(got[0]!.data!)).sort(), ['at', 'id', 'payload', 'seq', 'service', 'source', 'type', 'v']);
});

test('connect: 서버가 에러 상태를 보내면 스트림을 읽지 않고 실패한다', async () => {
  const server = createSseServer();
  await new Promise<void>((r) => server.listen(0, r));
  try {
    const url = `http://localhost:${(server.address() as AddressInfo).port}/events?scenario=nope`;
    await assert.rejects(connect(url, () => {}), /HTTP 404/);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
