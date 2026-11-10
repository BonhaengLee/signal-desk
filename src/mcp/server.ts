// 조사 도구를 MCP 서버로 노출한다. 에이전트 루프(src/agent)와 같은 도구 정의(TOOL_SPECS)·실행기(runTool)를 쓴다.
// Claude Code 같은 MCP 클라이언트가 붙어서 사람이 직접 장애를 조사할 수 있다. 원인 제출(submit_root_cause)은 빼고 판단은 클라이언트에 맡긴다.
// 실행: node src/mcp/server.ts  (stdio)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { runTool, TOOL_SPECS, type ToolContext } from '../agent/tools.ts';
import { contextFor } from '../agent/eval.ts';
import { isScenario, parseAtSec, parseSeed, SCENARIOS } from '../simulator/catalog.ts';
import type { Scenario } from '../simulator/simulate.ts';

const SCENARIO_DIR = fileURLToPath(new URL('../../scenarios/', import.meta.url));

const LOAD_INCIDENT = {
  name: 'load_incident',
  description: '조사할 장애를 고른다. 다른 도구는 이걸 먼저 불러야 한다. 정답(rootCause)은 돌려주지 않는다',
  inputSchema: {
    type: 'object',
    properties: {
      scenario: { type: 'string', enum: SCENARIOS },
      seed: { type: 'integer', minimum: 1, description: '같은 시드면 같은 이벤트가 나온다' },
      atSec: {
        type: 'number',
        minimum: 0,
        description: '시나리오 시작부터 이 초까지의 기록만 본다(장애가 진행 중인 시점의 조사). 빼면 끝난 장애를 돌아보는 것으로 보고 전체 기록을 준다',
      },
    },
    required: ['scenario'],
  },
} as const;

// 에이전트용 도구 정의를 MCP 형식으로 옮긴다. 원인 제출은 MCP 쪽에 두지 않는다
const INVESTIGATION_TOOLS = TOOL_SPECS.filter((t) => t.function.name !== 'submit_root_cause').map((t) => ({
  name: t.function.name,
  description: t.function.description,
  inputSchema: t.function.parameters,
}));

const text = (value: unknown, isError = false) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  ...(isError ? { isError: true } : {}),
});

export function createMcpServer(): Server {
  // 저수준 Server 를 쓰는 이유: McpServer.registerTool 은 zod 스키마를 요구한다.
  // 에이전트가 이미 쓰는 JSON Schema(TOOL_SPECS)를 그대로 내보내야 두 경로의 도구 정의가 하나로 유지된다
  const server = new Server({ name: 'signal-desk', version: '0.2.0' }, { capabilities: { tools: {} } });
  let ctx: ToolContext | undefined;

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [LOAD_INCIDENT, ...INVESTIGATION_TOOLS] }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    if (name === LOAD_INCIDENT.name) {
      const scenario = String(args.scenario);
      if (!isScenario(scenario)) return text({ error: `모르는 시나리오: ${scenario}` }, true);
      const sd = parseSeed(args.seed, 1);
      if (!sd.ok) return text({ error: sd.error }, true);
      const { seed } = sd;
      const s = JSON.parse(readFileSync(`${SCENARIO_DIR}${scenario}.json`, 'utf8')) as Scenario;
      const at = parseAtSec(args.atSec, s.durationSec);
      if (!at.ok) return text({ error: at.error }, true);
      ctx = contextFor(s, seed, at.atSec);
      // 어디까지의 기록인지 돌려줘야 클라이언트가 "아직 안 일어난 일"을 근거로 쓰지 않는다
      return text({ scenario, seed, untilSec: at.atSec ?? s.durationSec, events: ctx.events.length, entry: s.entry, description: '조사 시작. 정답은 숨김' });
    }
    if (!INVESTIGATION_TOOLS.some((t) => t.name === name)) return text({ error: `모르는 도구: ${name}` }, true);
    if (!ctx) return text({ error: '먼저 load_incident 를 호출해' }, true);
    const result = runTool(ctx, name, args);
    const failed = typeof result === 'object' && result !== null && 'error' in result;
    return text(result, failed);
  });

  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await createMcpServer().connect(new StdioServerTransport());
}
