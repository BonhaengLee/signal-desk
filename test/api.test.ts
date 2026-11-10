import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createSseServer } from '../src/server/sse.ts';
import { createApiHandler } from '../src/server/api.ts';
import { AuditStore } from '../src/audit/store.ts';
import { connect, type SseMessage } from '../src/client/sse.ts';
import type { ChatFn } from '../src/agent/agent.ts';

/** 배포 이력을 한 번 보고 payment-api 배포 탓으로 제출하는 가짜 모델 */
const fakeChat: ChatFn = async (messages) => {
  const turn = messages.filter((m) => m.role === 'assistant').length;
  const call = turn === 0
    ? { name: 'list_deploys', arguments: '{}' }
    : { name: 'submit_root_cause', arguments: JSON.stringify({ service: 'payment-api', kind: 'deploy', summary: '배포 직후 지연이 올랐다', evidence: [{ step: 1, fact: 'T+60 payment-api 배포' }], ruledOut: [{ service: 'payment-db', why: '지연 변화 없음' }] }) };
  return { role: 'assistant', content: null, tool_calls: [{ id: `c${turn}`, function: call }] };
};

async function start(chat: ChatFn = fakeChat) {
  const store = new AuditStore();
  const api = createApiHandler({ store, chat, model: 'fake', pollMs: 10 });
  const server = createSseServer({ extra: api.handle });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) =>
    fetch(base + path, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  return { store, api, base, post, close: () => new Promise((r) => server.close(r)) };
}

test('조사 시작 → 단계 기록 → 조치 제안 → 승인 → 실행 기록', async () => {
  const t = await start();
  try {
    const res = await t.post('/investigations', { scenario: 'hidden-deploy', seed: 1 });
    assert.equal(res.status, 202);
    const { id } = (await res.json()) as { id: string };
    await t.api.idle();

    const view = (await (await fetch(`${t.base}/investigations/${id}`)).json()) as { events: { kind: string }[]; proposals: { id: string; action: unknown; status: string }[] };
    assert.deepEqual(view.events.map((e) => e.kind), ['investigation_started', 'tool_call', 'tool_call', 'verdict', 'proposal']);
    assert.deepEqual(view.proposals.map((p) => [p.status, p.action]), [['pending', { type: 'rollback', service: 'payment-api', version: 'v1.4.2' }]]);

    const ok = await t.post(`/proposals/${view.proposals[0]!.id}/decision`, { operator: 'kim', decision: 'approved' });
    assert.deepEqual([ok.status, ((await ok.json()) as { status: string }).status], [200, 'executed']);
    const again = await t.post(`/proposals/${view.proposals[0]!.id}/decision`, { operator: 'lee', decision: 'rejected', reason: '늦은 클릭' });
    assert.equal(again.status, 409);
  } finally {
    await t.close();
  }
});

test('조사 스트림은 감사 로그를 seq 순서로 보내고 Last-Event-ID 다음부터 이어 준다', async () => {
  const t = await start();
  try {
    const { id } = (await (await t.post('/investigations', { scenario: 'hidden-deploy' })).json()) as { id: string };
    await t.api.idle();
    const read = async (headers: Record<string, string>) => {
      const got: SseMessage[] = [];
      const ac = new AbortController();
      await connect(`${t.base}/investigations/${id}/stream`, (m) => {
        got.push(m);
        if (m.event === 'proposal') ac.abort();
      }, { signal: ac.signal, headers }).catch(() => {});
      return got;
    };
    const all = await read({});
    assert.deepEqual(all.map((m) => m.id), ['1', '2', '3', '4', '5']);
    const rest = await read({ 'Last-Event-ID': '3' });
    assert.deepEqual(rest.map((m) => [m.id, m.event]), [['4', 'verdict'], ['5', 'proposal']]);
  } finally {
    await t.close();
  }
});

test('잘못된 입력은 400·404, 모델 오류는 investigation_failed 로 남는다', async () => {
  const t = await start(async () => {
    throw new Error('LLM HTTP 429');
  });
  try {
    assert.equal((await t.post('/investigations', { scenario: '../package' })).status, 400);
    assert.equal((await fetch(`${t.base}/investigations/00000000-0000-0000-0000-000000000000`)).status, 404);
    const { id } = (await (await t.post('/investigations', { scenario: 'silent-db' })).json()) as { id: string };
    await t.api.idle();
    const last = t.store.events(id).at(-1)!;
    assert.deepEqual([last.kind, last.payload], ['investigation_failed', { reason: 'LLM HTTP 429' }]);
    const bad = await fetch(`${t.base}/proposals/00000000-0000-0000-0000-000000000000/decision`, { method: 'POST', body: '{not json' });
    assert.equal(bad.status, 400);
  } finally {
    await t.close();
  }
});
