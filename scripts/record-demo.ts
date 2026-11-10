// 데모용 조사 녹화. 실제 모델로 조사를 돌리고 감사 로그를 "조치 제안"까지만 잘라 demo/investigations/<시나리오>.json 에 쓴다.
// 승인·거절은 데모 방문자가 하도록 결정·실행 기록은 넣지 않는다.
// 사용법:
//   node --env-file=.env.local scripts/record-demo.ts <시나리오...>        새로 조사해 녹화 (LLM 호출 건당 약 9회)
//   node scripts/record-demo.ts --from-db var/audit.db <조사 id>          이미 돌린 조사를 녹화로 옮김 (LLM 호출 없음)

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { AuditStore, type AuditEvent } from '../src/audit/store.ts';
import { openAiChat } from '../src/agent/agent.ts';
import { contextFor } from '../src/agent/eval.ts';
import { runInvestigation } from '../src/agent/run.ts';
import type { Scenario } from '../src/simulator/simulate.ts';

export const DEMO_SEED = 42; // 화면 스트림과 같은 시드
const OUT = 'demo/investigations';

/** 제안까지만 남긴다. 제안이 없으면(결론 실패) 그대로 둔다 */
export function untilProposal(events: AuditEvent[]): AuditEvent[] {
  const i = events.findIndex((e) => e.kind === 'proposal');
  return i < 0 ? events : events.slice(0, i + 1);
}

function save(id: string, scenario: string, events: AuditEvent[]) {
  mkdirSync(OUT, { recursive: true });
  const kept = untilProposal(events);
  writeFileSync(`${OUT}/${scenario}.json`, JSON.stringify({ id, scenario, seed: DEMO_SEED, events: kept }, null, 2) + '\n');
  console.log(`${scenario}: ${kept.length}건 (${kept.at(-1)?.kind}) → ${OUT}/${scenario}.json`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args[0] === '--from-db') {
    const store = new AuditStore(args[1]!);
    for (const id of args.slice(2)) {
      const row = store.db.prepare('SELECT scenario, seed FROM investigations WHERE id = ?').get(id) as { scenario: string; seed: number } | undefined;
      if (!row || row.seed !== DEMO_SEED) throw new Error(`${id}: 없거나 시드가 ${DEMO_SEED} 가 아님`);
      save(id, row.scenario, store.events(id));
    }
  } else {
    const { LLM_BASE_URL, LLM_API_KEY, LLM_MODEL = 'nemotron-3.5-lightning-30b-a3b' } = process.env;
    if (!LLM_BASE_URL || !LLM_API_KEY) throw new Error('LLM_BASE_URL, LLM_API_KEY 필요 (.env.local)');
    const chat = openAiChat(LLM_BASE_URL, LLM_API_KEY, LLM_MODEL);
    for (const name of args) {
      const store = new AuditStore(':memory:');
      const s = JSON.parse(readFileSync(`scenarios/${name}.json`, 'utf8')) as Scenario;
      const id = store.createInvestigation(name, DEMO_SEED, LLM_MODEL);
      await runInvestigation(store, id, contextFor(s, DEMO_SEED), chat);
      save(id, name, store.events(id));
    }
  }
}
