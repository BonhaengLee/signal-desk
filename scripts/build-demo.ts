// 정적 데모 데이터 만들기. 서버 없이 브라우저가 재생할 파일을 src/web/public/demo/ 에 쓴다 (생성물이라 커밋하지 않는다).
// - events/<시나리오>.json: 시뮬레이터 이벤트(시드 42)와 각 이벤트의 시나리오 경과 초. 시나리오 정의(정답 포함)는 넣지 않는다
// - investigations/<id>.json, investigations/index.json: demo/investigations 의 녹화와 시나리오 → id 목록
// 사용법: node scripts/build-demo.ts

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { simulate, type Scenario } from '../src/simulator/simulate.ts';
import { DEMO_SEED } from './record-demo.ts';

export const DEMO_SCENARIOS = ['deploy-regression', 'db-degradation', 'retry-storm']; // 화면 선택 목록과 같다
const OUT = 'src/web/public/demo';

export function demoEvents(s: Scenario, seed = DEMO_SEED) {
  const start = Date.parse(s.startAt);
  return { durationSec: s.durationSec, events: [...simulate(s, seed)].map((e) => ({ simSec: (e.at.getTime() - start) / 1000, event: e })) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(`${OUT}/events`, { recursive: true });
  mkdirSync(`${OUT}/investigations`, { recursive: true });
  for (const name of DEMO_SCENARIOS) {
    const s = JSON.parse(readFileSync(`scenarios/${name}.json`, 'utf8')) as Scenario;
    writeFileSync(`${OUT}/events/${name}.json`, JSON.stringify(demoEvents(s)));
  }
  const index: Record<string, string> = {};
  for (const f of readdirSync('demo/investigations').filter((f) => f.endsWith('.json'))) {
    const rec = JSON.parse(readFileSync(`demo/investigations/${f}`, 'utf8')) as { id: string; scenario: string };
    index[rec.scenario] = rec.id;
    writeFileSync(`${OUT}/investigations/${rec.id}.json`, JSON.stringify(rec));
  }
  writeFileSync(`${OUT}/investigations/index.json`, JSON.stringify(index));
  console.log(`데모 데이터: 시나리오 ${DEMO_SCENARIOS.length}개, 녹화 ${Object.keys(index).length}건 → ${OUT}`);
}
