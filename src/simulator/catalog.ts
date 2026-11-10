// 시나리오 목록과 요청 값(seed·atSec) 규칙. SSE 서버·조사 API·MCP·평가가 같은 정의를 쓴다

export const SCENARIOS = ['deploy-regression', 'db-degradation', 'retry-storm', 'silent-db', 'hidden-deploy'] as const;
export type ScenarioName = (typeof SCENARIOS)[number];

/** 목록에 있는 이름만 받는다. 사용자 입력으로 파일 경로를 만들지 않기 위해서다 */
export const isScenario = (name: unknown): name is ScenarioName => (SCENARIOS as readonly unknown[]).includes(name);

export const SEED_MAX = 1_000_000;

/** 요청으로 받은 seed 를 검사한다. 없으면 fallback. 숫자 문자열·true 처럼 형식이 다른 값은 바꿔 받지 않는다 */
export function parseSeed(raw: unknown, fallback: number): { ok: true; seed: number } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, seed: fallback };
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= SEED_MAX) return { ok: true, seed: raw };
  return { ok: false, error: `seed 는 1~${SEED_MAX} 정수` };
}

/** 요청으로 받은 atSec 을 검사한다. 없으면 전체 기록 */
export function parseAtSec(raw: unknown, durationSec: number): { ok: true; atSec?: number } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true };
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= durationSec) return { ok: true, atSec: raw };
  return { ok: false, error: `atSec 은 0~${durationSec} 초` };
}
