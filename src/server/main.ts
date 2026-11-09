// 사용법: PORT=4100 node --env-file=.env.local src/server/main.ts
// 브라우저에서 http://localhost:4100/events?scenario=deploy-regression&speed=5
// LLM_BASE_URL·LLM_API_KEY 가 있으면 조사 API(/investigations, /proposals)도 켠다. 감사 로그는 var/audit.db

import { mkdirSync } from 'node:fs';
import { createSseServer, type ServerOptions } from './sse.ts';
import { createApiHandler } from './api.ts';
import { AuditStore } from '../audit/store.ts';
import { openAiChat } from '../agent/agent.ts';

const port = Number(process.env.PORT ?? 4100);
const { LLM_BASE_URL, LLM_API_KEY } = process.env;
const model = process.env.LLM_MODEL ?? 'nemotron-3.5-lightning-30b-a3b';

let extra: ServerOptions['extra'];
if (LLM_BASE_URL && LLM_API_KEY) {
  mkdirSync('var', { recursive: true });
  extra = createApiHandler({ store: new AuditStore('var/audit.db'), chat: openAiChat(LLM_BASE_URL, LLM_API_KEY, model), model }).handle;
}

createSseServer({ extra }).listen(port, () => {
  console.log(`SSE 서버: http://localhost:${port}/events?scenario=deploy-regression&seed=42&speed=1`);
  console.log(extra ? `조사 API 켜짐 (모델 ${model})` : '조사 API 꺼짐: LLM_BASE_URL, LLM_API_KEY 없음');
});
