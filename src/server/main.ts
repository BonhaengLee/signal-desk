// 사용법: PORT=4100 node --env-file=.env.local src/server/main.ts
// 브라우저에서 http://localhost:4100/events?scenario=deploy-regression&speed=5
// LLM_BASE_URL·LLM_API_KEY 가 있으면 조사 API(/investigations, /proposals)도 켠다. 감사 로그는 var/audit.db

import { mkdirSync } from 'node:fs';
import { createSseServer, type ServerOptions } from './sse.ts';
import { createApiHandler } from './api.ts';
import { AuditStore } from '../audit/store.ts';
import { openAiChat } from '../agent/agent.ts';

const port = Number(process.env.PORT ?? 4100);
// 인증이 없는 서버라 기본은 이 기계에서만 받는다. 다른 기계에서 붙이려면 HOST=0.0.0.0
const host = process.env.HOST ?? '127.0.0.1';
const { LLM_BASE_URL, LLM_API_KEY } = process.env;
const model = process.env.LLM_MODEL ?? 'nemotron-3.5-lightning-30b-a3b';

let extra: ServerOptions['extra'];
if (LLM_BASE_URL && LLM_API_KEY) {
  mkdirSync('var', { recursive: true });
  extra = createApiHandler({ store: new AuditStore('var/audit.db'), chat: openAiChat(LLM_BASE_URL, LLM_API_KEY, model), model }).handle;
}

createSseServer({ extra }).listen(port, host, () => {
  console.log(`SSE 서버: http://${host}:${port}/events?scenario=deploy-regression&seed=42&speed=1`);
  console.log(extra ? `조사 API 켜짐 (모델 ${model})` : '조사 API 꺼짐: LLM_BASE_URL, LLM_API_KEY 없음');
});
