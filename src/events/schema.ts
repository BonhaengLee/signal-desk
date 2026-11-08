// 이벤트 스키마와 검증기.
// 네트워크·파일·외부 데이터에서 온 값은 모양을 믿지 않는다. parseEvent 를 통과한 값만 앱 안으로 들인다.
// 검증 라이브러리는 ADR-0001 에서 정한다. 그 전까지는 이 직접 구현이 비교 대상 1번이다.

export const SCHEMA_VERSION = 1;

export const EVENT_TYPES = ['metric', 'log', 'deploy', 'alert'] as const;
export const SOURCES = ['simulator', 'rcaeval'] as const;
export const LOG_LEVELS = ['info', 'warn', 'error'] as const;
export const ALERT_LEVELS = ['warn', 'error'] as const;
export const ALERT_STATES = ['firing', 'resolved'] as const;

export type EventType = (typeof EVENT_TYPES)[number];
export type Source = (typeof SOURCES)[number];
export type LogLevel = (typeof LOG_LEVELS)[number];
export type AlertLevel = (typeof ALERT_LEVELS)[number];
export type AlertState = (typeof ALERT_STATES)[number];

interface EventBase {
  v: typeof SCHEMA_VERSION;
  id: string;
  seq: number;
  source: Source;
  service: string;
  at: Date; // 시뮬레이션 안에서 사건이 일어난 시각. 전송 형식은 ISO 문자열
}

export type MetricEvent = EventBase & { type: 'metric'; payload: { name: string; value: number; unit: string } };
export type LogEvent = EventBase & { type: 'log'; payload: { level: LogLevel; message: string } };
export type DeployEvent = EventBase & { type: 'deploy'; payload: { version: string; actor: string } };
export type AlertEvent = EventBase & {
  type: 'alert';
  payload: { level: AlertLevel; rule: string; state: AlertState };
};

export type SignalEvent = MetricEvent | LogEvent | DeployEvent | AlertEvent;

export type ParseResult = { ok: true; event: SignalEvent } | { ok: false; errors: string[] };

// new Date('1') 같은 느슨한 해석을 막으려고 형식을 먼저 본다
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

type Rec = Record<string, unknown>;

function isRecord(x: unknown): x is Rec {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function show(x: unknown): string {
  return x === undefined ? 'undefined' : JSON.stringify(x);
}

function checkString(obj: Rec, key: string, path: string, errors: string[]): string | undefined {
  const x = obj[key];
  if (typeof x === 'string' && x.length > 0) return x;
  errors.push(`${path}: 비어 있지 않은 문자열이어야 함 (받은 값 ${show(x)})`);
  return undefined;
}

function checkOneOf<T extends string>(
  obj: Rec,
  key: string,
  allowed: readonly T[],
  path: string,
  errors: string[],
): T | undefined {
  const x = obj[key];
  if (typeof x === 'string' && (allowed as readonly string[]).includes(x)) return x as T;
  errors.push(`${path}: ${allowed.join('|')} 중 하나여야 함 (받은 값 ${show(x)})`);
  return undefined;
}

function checkPayload(type: EventType, raw: unknown, errors: string[]): SignalEvent['payload'] | undefined {
  if (!isRecord(raw)) {
    errors.push(`payload: 객체여야 함 (받은 값 ${show(raw)})`);
    return undefined;
  }
  const before = errors.length;
  switch (type) {
    case 'metric': {
      const name = checkString(raw, 'name', 'payload.name', errors);
      const unit = checkString(raw, 'unit', 'payload.unit', errors);
      const value = raw.value;
      // NaN·Infinity 는 JSON 을 거치면 null 이 된다. 숫자가 아닌 값은 여기서 막는다
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push(`payload.value: 유한한 숫자여야 함 (받은 값 ${show(value)})`);
      }
      if (errors.length > before) return undefined;
      return { name: name!, value: value as number, unit: unit! };
    }
    case 'log': {
      const level = checkOneOf(raw, 'level', LOG_LEVELS, 'payload.level', errors);
      const message = checkString(raw, 'message', 'payload.message', errors);
      if (errors.length > before) return undefined;
      return { level: level!, message: message! };
    }
    case 'deploy': {
      const version = checkString(raw, 'version', 'payload.version', errors);
      const actor = checkString(raw, 'actor', 'payload.actor', errors);
      if (errors.length > before) return undefined;
      return { version: version!, actor: actor! };
    }
    case 'alert': {
      const level = checkOneOf(raw, 'level', ALERT_LEVELS, 'payload.level', errors);
      const rule = checkString(raw, 'rule', 'payload.rule', errors);
      const state = checkOneOf(raw, 'state', ALERT_STATES, 'payload.state', errors);
      if (errors.length > before) return undefined;
      return { level: level!, rule: rule!, state: state! };
    }
  }
}

/** JSON.parse 결과를 검사해 앱 안에서 쓸 이벤트로 바꾼다. 알 수 없는 필드는 버린다. */
export function parseEvent(raw: unknown): ParseResult {
  if (!isRecord(raw)) return { ok: false, errors: [`이벤트: 객체여야 함 (받은 값 ${show(raw)})`] };
  const errors: string[] = [];

  if (raw.v !== SCHEMA_VERSION) errors.push(`v: ${SCHEMA_VERSION} 이어야 함 (받은 값 ${show(raw.v)})`);
  const id = checkString(raw, 'id', 'id', errors);
  const seq = raw.seq;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) {
    errors.push(`seq: 0 이상의 정수여야 함 (받은 값 ${show(seq)})`);
  }
  const source = checkOneOf(raw, 'source', SOURCES, 'source', errors);
  const service = checkString(raw, 'service', 'service', errors);

  let at: Date | undefined;
  if (typeof raw.at === 'string' && ISO_UTC.test(raw.at) && !Number.isNaN(Date.parse(raw.at))) {
    at = new Date(raw.at);
  } else {
    errors.push(`at: UTC ISO 문자열이어야 함 (받은 값 ${show(raw.at)})`);
  }

  const type = checkOneOf(raw, 'type', EVENT_TYPES, 'type', errors);
  // type 을 모르면 payload 규칙을 고를 수 없으므로 payload 검사는 건너뛴다
  const payload = type ? checkPayload(type, raw.payload, errors) : undefined;

  if (errors.length > 0) return { ok: false, errors };
  const event = { v: SCHEMA_VERSION, id: id!, seq: seq as number, source: source!, service: service!, at: at!, type: type!, payload: payload! };
  return { ok: true, event: event as SignalEvent };
}
