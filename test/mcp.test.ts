import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/server.ts';
import { runTool } from '../src/agent/tools.ts';
import { contextFor } from '../src/agent/eval.ts';
import type { Scenario } from '../src/simulator/simulate.ts';

async function connected() {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([createMcpServer().connect(a), client.connect(b)]);
  return client;
}

const body = (r: object) => JSON.parse(((r as { content: { text: string }[] }).content)[0]!.text);

test('도구 목록은 load_incident + 조사 도구 5개이고, 원인 제출 도구는 없다', async () => {
  const client = await connected();
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name),
    ['load_incident', 'get_topology', 'list_alerts', 'list_deploys', 'get_metric', 'get_logs'],
  );
});

test('load_incident 전에 조사 도구를 부르면 오류', async () => {
  const client = await connected();
  const r = await client.callTool({ name: 'list_alerts', arguments: {} });
  assert.deepEqual([r.isError, body(r)], [true, { error: '먼저 load_incident 를 호출해' }]);
});

test('MCP 로 받은 결과가 에이전트가 받는 결과와 같고, 정답은 새지 않는다', async () => {
  const client = await connected();
  const loaded = await client.callTool({ name: 'load_incident', arguments: { scenario: 'silent-db', seed: 2 } });
  assert.equal(JSON.stringify(body(loaded)).includes('rootCause'), false);

  const scenario = JSON.parse(readFileSync('scenarios/silent-db.json', 'utf8')) as Scenario;
  const ctx = contextFor(scenario, 2);
  for (const [name, args] of [
    ['list_alerts', {}],
    ['get_metric', { service: 'payment-db', name: 'latency_p99' }],
  ] as const) {
    const r = await client.callTool({ name, arguments: args });
    assert.deepEqual(body(r), JSON.parse(JSON.stringify(runTool(ctx, name, args))));
  }
});

test('잘못된 시나리오·서비스는 isError 로 돌려준다', async () => {
  const client = await connected();
  const bad = await client.callTool({ name: 'load_incident', arguments: { scenario: '../package' } });
  assert.deepEqual([bad.isError, body(bad)], [true, { error: '모르는 시나리오: ../package' }]);
  await client.callTool({ name: 'load_incident', arguments: { scenario: 'retry-storm' } });
  const r = await client.callTool({ name: 'get_logs', arguments: { service: 'nope' } });
  assert.deepEqual([r.isError, body(r)], [true, { error: '모르는 서비스: nope' }]);
});
