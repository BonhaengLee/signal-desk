// 사용법: node src/simulator/cli.ts [시나리오 파일] [시드]
// 이벤트를 한 줄에 하나씩 JSON 으로 출력한다 (NDJSON)

import { readFileSync } from 'node:fs';
import { simulate, type Scenario } from './simulate.ts';

const file = process.argv[2] ?? 'scenarios/deploy-regression.json';
const seed = Number(process.argv[3] ?? 42);
const scenario = JSON.parse(readFileSync(file, 'utf8')) as Scenario; // 시나리오 스키마 검증은 다음 단계

for (const event of simulate(scenario, seed)) {
  process.stdout.write(JSON.stringify(event) + '\n');
}
