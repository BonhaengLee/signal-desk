// 이벤트 배열에서 화면에 필요한 값을 계산하는 순수 함수들.
// 화면 상태는 이벤트 목록 하나뿐이고, 경보·차트·서비스 상태는 매번 여기서 다시 만든다 (따로 저장하면 reset 때 어긋난다).

import type { AlertEvent, AlertLevel, DeployEvent, SignalEvent } from '../events/schema.ts';

/** 시나리오 시작부터 지난 초를 `T+01:05` 로 쓴다. 벽시계 시각과 헷갈리지 않게 T+ 를 붙인다 */
export function formatElapsed(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  return `T+${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export const elapsedSec = (at: Date, originMs: number) => (at.getTime() - originMs) / 1000;

export type Point = { t: number; v: number };
export type AlertSpan = { service: string; level: AlertLevel; rule: string; from: number; to: number; open: boolean };
export type DeployMark = { t: number; service: string; version: string; actor: string };

export interface Timeline {
  services: string[]; // 처음 등장한 순서. 색 배정이 바뀌지 않도록 순서를 고정한다
  series: Map<string, Point[]>; // 서비스별 latency_p99
  deploys: DeployMark[];
  spans: AlertSpan[]; // 경보 발생~해소. 등급이 바뀌면 구간을 나눈다
  now: number; // 마지막으로 받은 이벤트의 경과 시간
}

const METRIC = 'latency_p99';

export function buildTimeline(events: readonly SignalEvent[], originMs: number): Timeline {
  const services: string[] = [];
  const seen = new Set<string>();
  const series = new Map<string, Point[]>();
  const deploys: DeployMark[] = [];
  const spans: AlertSpan[] = [];
  const open = new Map<string, AlertSpan>(); // 서비스별로 아직 끝나지 않은 구간
  let now = 0;

  for (const e of events) {
    const t = elapsedSec(e.at, originMs);
    if (t > now) now = t;
    if (!seen.has(e.service)) {
      seen.add(e.service);
      services.push(e.service);
    }
    switch (e.type) {
      case 'metric':
        if (e.payload.name === METRIC) {
          let pts = series.get(e.service);
          if (!pts) series.set(e.service, (pts = []));
          pts.push({ t, v: e.payload.value });
        }
        break;
      case 'deploy':
        deploys.push({ t, service: e.service, version: e.payload.version, actor: e.payload.actor });
        break;
      case 'alert': {
        const cur = open.get(e.service);
        if (e.payload.state === 'resolved') {
          if (cur) {
            cur.to = t;
            cur.open = false;
            open.delete(e.service);
          }
          break;
        }
        // 같은 서비스에서 다시 firing 이 오면(warn → error 등급 상승) 앞 구간을 닫고 새 구간을 연다
        if (cur) {
          cur.to = t;
          cur.open = false;
        }
        const span: AlertSpan = { service: e.service, level: e.payload.level, rule: e.payload.rule, from: t, to: t, open: true };
        spans.push(span);
        open.set(e.service, span);
        break;
      }
      case 'log':
        break;
    }
  }
  for (const s of open.values()) s.to = now; // 열린 구간은 지금까지 칠한다
  return { services, series, deploys, spans, now };
}

/** 서비스별로 가장 최근 firing 경보. resolved 가 오면 지운다 */
export function latestFiring(events: readonly SignalEvent[]): Map<string, AlertEvent> {
  const firing = new Map<string, AlertEvent>();
  for (const e of events) {
    if (e.type !== 'alert') continue;
    if (e.payload.state === 'firing') {
      firing.delete(e.service); // 다시 넣어서 Map 순서도 최근 순으로
      firing.set(e.service, e);
    } else firing.delete(e.service);
  }
  return firing;
}

/** 서비스·지표별 최근 값. key 는 `service\u0000metric` */
export function latestMetrics(events: readonly SignalEvent[]): Map<string, { value: number; unit: string }> {
  const out = new Map<string, { value: number; unit: string }>();
  for (const e of events) {
    if (e.type === 'metric') out.set(metricKey(e.service, e.payload.name), { value: e.payload.value, unit: e.payload.unit });
  }
  return out;
}
export const metricKey = (service: string, name: string) => `${service}\u0000${name}`;

export type ParsedRule = { metric: string; op: '>' | '<' | '>=' | '<='; threshold: number; unit: string };

/** `latency_p99 > 500ms` 같은 경보 규칙을 읽는다. 모양이 다르면 undefined (카드는 규칙 문자열만 보여 준다) */
export function parseRule(rule: string): ParsedRule | undefined {
  const m = /^\s*([A-Za-z_][\w.]*)\s*(>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)\s*([A-Za-z%]*)\s*$/.exec(rule);
  if (!m) return undefined;
  return { metric: m[1]!, op: m[2] as ParsedRule['op'], threshold: Number(m[3]), unit: m[4] ?? '' };
}

export function lastDeploy(events: readonly SignalEvent[], service: string): DeployEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === 'deploy' && e.service === service) return e;
  }
  return undefined;
}

export type Severity = 'error' | 'warn' | 'info' | 'deploy';
export const SEVERITIES: readonly Severity[] = ['error', 'warn', 'info', 'deploy'];

export function severityOf(e: SignalEvent): Severity {
  if (e.type === 'log' || e.type === 'alert') return e.payload.level;
  if (e.type === 'deploy') return 'deploy';
  return 'info';
}

/** 축 눈금용으로 보기 좋은 최댓값 (1·2·2.5·5 × 10^n) */
export function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * exp >= v) return m * exp;
  return 10 * exp;
}
