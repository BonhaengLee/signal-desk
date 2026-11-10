// 데모용 조사 녹화. 실제 모델로 조사를 돌리고 감사 로그를 "조치 제안"까지만 잘라 demo/investigations/<시나리오>.json 에 쓴다.
// 조사는 DEMO_AT_SEC 까지의 기록만 본다. 화면에서 그 시점에 조사를 누른 것과 같다.
// 승인·거절은 데모 방문자가 하도록 결정·실행 기록은 넣지 않는다.
// 사용법: node --env-file=.env.local scripts/record-demo.ts <시나리오...>   (LLM 호출 건당 약 9회)

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { AuditStore, type AuditEvent } from '../src/audit/store.ts';
import { openAiChat } from '../src/agent/agent.ts';
import { contextFor } from '../src/agent/eval.ts';
import { runInvestigation } from '../src/agent/run.ts';
import type { Scenario } from '../src/simulator/simulate.ts';

export const DEMO_SEED = 42; // 화면 스트림과 같은 시드
// 데모 시나리오 셋 다 첫 경보가 T+60~70 이고, retry-storm 의 함정(핫픽스 배포)이 T+100 이다. 그 뒤 20초까지 본다
export const DEMO_AT_SEC = 120;
const OUT = 'demo/investigations';

/** 제안까지만 남긴다. 제안이 없으면(결론 실패) 그대로 둔다 */
export function untilProposal(events: AuditEvent[]): AuditEvent[] {
  const i = events.findIndex((e) => e.kind === 'proposal');
  return i < 0 ? events : events.slice(0, i + 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { LLM_BASE_URL, LLM_API_KEY, LLM_MODEL = 'nemotron-3.5-lightning-30b-a3b' } = process.env;
  if (!LLM_BASE_URL || !LLM_API_KEY) throw new Error('LLM_BASE_URL, LLM_API_KEY 필요 (.env.local)');
  const chat = openAiChat(LLM_BASE_URL, LLM_API_KEY, LLM_MODEL);
  mkdirSync(OUT, { recursive: true });
  for (const name of process.argv.slice(2)) {
    const store = new AuditStore(':memory:');
    const s = JSON.parse(readFileSync(`scenarios/${name}.json`, 'utf8')) as Scenario;
    const id = store.createInvestigation(name, DEMO_SEED, LLM_MODEL, DEMO_AT_SEC);
    await runInvestigation(store, id, contextFor(s, DEMO_SEED, DEMO_AT_SEC), chat);
    const kept = untilProposal(store.events(id));
    writeFileSync(`${OUT}/${name}.json`, JSON.stringify({ id, scenario: name, seed: DEMO_SEED, atSec: DEMO_AT_SEC, events: kept }, null, 2) + '\n');
    console.log(`${name}: ${kept.length}건 (${kept.at(-1)?.kind}) → ${OUT}/${name}.json`);
  }
}
