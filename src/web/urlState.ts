// 화면 상태(시나리오·배속·필터)를 URL 쿼리와 주고받는다.
// 같은 링크를 열면 사람이든 브라우저 에이전트든 같은 화면에서 시작한다. 클릭 없이 원하는 상태로 바로 들어갈 수 있다.
//
// 쿼리 이름 (기본값이면 URL 에서 뺀다)
//   scenario=deploy-regression     시나리오
//   speed=5                        배속
//   metrics=show                   이벤트 목록에 지표도 보이기 (기본은 숨김)
//   severity=error,warn            목록에 보일 심각도 (기본은 전부)
//   hide-service=payment-db        목록에서 뺄 서비스
//   hide-line=inventory-api        차트에서 뺄 서비스 선
// 모르는 값은 버리고 기본값을 쓴다. URL 은 누구나 고쳐 열 수 있는 입력이다.
// 목록 값은 쉼표로 잇거나(severity=error,warn) 키를 되풀이해도(severity=error&severity=warn) 같다.

export type ViewState = {
  scenario: string;
  speed: string;
  hideMetrics: boolean;
  severities: Set<string>;
  hiddenServices: Set<string>;
  hiddenLines: Set<string>;
};

export type ViewOptions = {
  scenarios: readonly string[];
  speeds: readonly string[];
  severities: readonly string[];
  defaultScenario: string;
  defaultSpeed: string;
};

/** 서비스 이름으로 받아들이는 모양. 시뮬레이터 서비스 이름(소문자·숫자·하이픈)에 맞춘다 */
const SERVICE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const VIEW_KEYS = ['scenario', 'speed', 'metrics', 'severity', 'hide-service', 'hide-line'] as const;

function list(q: URLSearchParams, key: string): string[] {
  return q
    .getAll(key)
    .flatMap((v) => v.split(','))
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

function services(q: URLSearchParams, key: string): Set<string> {
  return new Set(list(q, key).filter((x) => SERVICE_NAME.test(x)));
}

export function parseView(search: string, o: ViewOptions): ViewState {
  const q = new URLSearchParams(search);
  const scenario = q.get('scenario');
  const speed = q.get('speed');
  const hasSev = q.has('severity');
  return {
    scenario: scenario !== null && o.scenarios.includes(scenario) ? scenario : o.defaultScenario,
    speed: speed !== null && o.speeds.includes(speed) ? speed : o.defaultSpeed,
    hideMetrics: q.get('metrics') !== 'show',
    // severity= 처럼 값이 비어 있으면 "아무것도 안 보이기" 로 읽는다. 쿼리가 아예 없을 때만 전부 보인다
    severities: hasSev ? new Set(list(q, 'severity').filter((x) => o.severities.includes(x))) : new Set(o.severities),
    hiddenServices: services(q, 'hide-service'),
    hiddenLines: services(q, 'hide-line'),
  };
}

/** 기본값과 다른 것만 쿼리에 남긴다. 순서는 고정해 같은 상태가 같은 URL 이 되게 한다 */
export function serializeView(v: ViewState, o: ViewOptions): string {
  const q = new URLSearchParams();
  if (v.scenario !== o.defaultScenario) q.set('scenario', v.scenario);
  if (v.speed !== o.defaultSpeed) q.set('speed', v.speed);
  if (!v.hideMetrics) q.set('metrics', 'show');
  if (v.severities.size !== o.severities.length || o.severities.some((x) => !v.severities.has(x))) {
    q.set('severity', o.severities.filter((x) => v.severities.has(x)).join(','));
  }
  if (v.hiddenServices.size > 0) q.set('hide-service', [...v.hiddenServices].sort().join(','));
  if (v.hiddenLines.size > 0) q.set('hide-line', [...v.hiddenLines].sort().join(','));
  // 쉼표는 이름 구분자라 그대로 둔다. 사람이 읽고 고치기 쉬운 URL 이 목적이다
  return q.toString().replaceAll('%2C', ',');
}

/** 지금 쿼리에서 화면 상태 키만 바꿔 끼운다. 모르는 키(추적 파라미터 등)는 그대로 둔다 */
export function applyView(search: string, v: ViewState, o: ViewOptions): string {
  const q = new URLSearchParams(search);
  for (const k of VIEW_KEYS) q.delete(k);
  const rest = q.toString();
  const view = serializeView(v, o);
  return [view, rest].filter(Boolean).join('&');
}
