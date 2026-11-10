import { useEffect, useMemo, useState } from 'react';
import type { AlertEvent, SignalEvent } from '../events/schema.ts';
import { useSignalStream, type StreamStatus } from './useSignalStream.ts';
import { EventList, describe } from './EventList.tsx';
import { Timeline } from './Timeline.tsx';
import { InvestigationPanel } from './Investigation.tsx';
import {
  SEVERITIES,
  buildTimeline,
  formatElapsed,
  lastDeploy,
  latestFiring,
  latestMetrics,
  metricKey,
  parseRule,
  severityOf,
  type Point,
  type Severity,
} from './derive.ts';
import { Badge, Card, ChipGroup, EmptyState, Segmented, Select, Switch, VisuallyHidden, type Tone } from './ui/controls.tsx';
import { applyView, parseView, type ViewOptions } from './urlState.ts';
// 시나리오 파일에서는 이름·시작 시각·길이만 가져온다. 시각 표기를 "시나리오 경과 시간" 으로 바꾸고 차트 x 축을 고정하는 데 쓴다.
// 파일 전체를 가져오면 정답(rootCause)과 원인을 적은 설명(description)이 화면 번들에 들어가, 화면을 읽는 사람과 에이전트가 답을 보게 된다.
// 이름 붙은 가져오기만 쓰면 Vite 가 나머지 키를 번들에서 뺀다
import { name as n1, startAt as a1, durationSec as d1, tickSec as t1 } from '../../scenarios/deploy-regression.json';
import { name as n2, startAt as a2, durationSec as d2, tickSec as t2 } from '../../scenarios/db-degradation.json';
import { name as n3, startAt as a3, durationSec as d3, tickSec as t3 } from '../../scenarios/retry-storm.json';

type ScenarioMeta = { name: string; startAt: string; durationSec: number; tickSec: number };
const SCENARIOS: ScenarioMeta[] = [
  { name: n1, startAt: a1, durationSec: d1, tickSec: t1 },
  { name: n2, startAt: a2, durationSec: d2, tickSec: t2 },
  { name: n3, startAt: a3, durationSec: d3, tickSec: t3 },
];
type ScenarioName = 'deploy-regression' | 'db-degradation' | 'retry-storm';
const SCENARIO_OPTIONS = SCENARIOS.map((sc) => ({ id: sc.name as ScenarioName, label: sc.name }));

const SPEEDS = [
  { id: '1', label: '1x' },
  { id: '5', label: '5x' },
  { id: '20', label: '20x' },
] as const;
type Speed = (typeof SPEEDS)[number]['id'];

const STATUS: Record<StreamStatus, { label: string; tone: Tone; pulse: boolean; help: string }> = {
  connecting: { label: '연결 중', tone: 'neutral', pulse: true, help: 'SSE 서버에 연결하고 있습니다' },
  open: { label: '실시간', tone: 'ok', pulse: true, help: 'SSE 로 이벤트를 받는 중입니다' },
  closed: { label: '연결 종료', tone: 'neutral', pulse: false, help: '서버가 스트림을 닫았습니다' },
  error: { label: '연결 실패', tone: 'error', pulse: false, help: 'SSE 서버에 연결하지 못했습니다' },
};

const ERROR_RATE_HIGHLIGHT = 5; // %
const METRIC_LABEL: Record<string, string> = { latency_p99: 'p99', error_rate: '오류율' };
const SEVERITY_LABEL: Record<Severity, string> = { error: '에러', warn: '경고', info: '정보', deploy: '배포' };
const SERIES_COLORS = ['--series-1', '--series-2', '--series-3', '--series-4', '--series-5', '--series-6'];

const VIEW_OPTIONS: ViewOptions = {
  scenarios: SCENARIO_OPTIONS.map((o) => o.id),
  speeds: SPEEDS.map((o) => o.id),
  severities: SEVERITIES,
  defaultScenario: 'deploy-regression',
  defaultSpeed: '5',
};

export function App() {
  // 처음 상태는 URL 에서 읽는다 (urlState.ts). 링크로 같은 화면을 다시 열 수 있다
  const [initial] = useState(() => parseView(location.search, VIEW_OPTIONS));
  const [scenarioName, setScenarioName] = useState<ScenarioName>(initial.scenario as ScenarioName);
  const [speed, setSpeed] = useState<Speed>(initial.speed as Speed);
  const [hideMetrics, setHideMetrics] = useState(initial.hideMetrics);
  const [severities, setSeverities] = useState<Set<string>>(initial.severities);
  const [hiddenServices, setHiddenServices] = useState<Set<string>>(initial.hiddenServices); // 목록 필터. 새로 나타난 서비스는 기본으로 보인다
  const [hiddenLines, setHiddenLines] = useState<Set<string>>(initial.hiddenLines); // 차트에서 숨긴 선

  // 상태가 바뀌면 URL 을 고친다. 뒤로 가기 기록을 쌓지 않도록 replaceState 를 쓰고, 모르는 쿼리·#해시·history.state 는 보존한다
  useEffect(() => {
    const qs = applyView(location.search, { scenario: scenarioName, speed, hideMetrics, severities, hiddenServices, hiddenLines }, VIEW_OPTIONS);
    if ((qs ? `?${qs}` : '') === location.search) return;
    history.replaceState(history.state, '', `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`);
  }, [scenarioName, speed, hideMetrics, severities, hiddenServices, hiddenLines]);
  const { events, status, rejected } = useSignalStream(`/events?scenario=${scenarioName}&seed=42&speed=${speed}`);

  const scenario = SCENARIOS.find((sc) => sc.name === scenarioName)!;
  const origin = Date.parse(scenario.startAt);

  const timeline = useMemo(() => buildTimeline(events, origin), [events, origin]);
  const firing = useMemo(() => latestFiring(events), [events]);
  const metrics = useMemo(() => latestMetrics(events), [events]);

  // 서비스별 색은 처음 나타난 순서로 고정한다. 칩·선·툴팁이 같은 색을 쓴다
  const colors = useMemo(() => {
    const css = getComputedStyle(document.documentElement);
    return new Map(timeline.services.map((sv, i) => [sv, css.getPropertyValue(SERIES_COLORS[i % SERIES_COLORS.length]!).trim()]));
  }, [timeline.services.join()]);

  // 칩 옆 건수는 "그 칩을 켜면 목록에 몇 건이 보이나" 다. 심각도 건수는 서비스 필터를, 서비스 건수는 심각도 필터를 반영한다
  const counts = useMemo(() => {
    const bySev = new Map<string, number>();
    const bySvc = new Map<string, number>();
    for (const e of events) {
      if (hideMetrics && e.type === 'metric') continue;
      const sev = severityOf(e);
      if (!hiddenServices.has(e.service)) bySev.set(sev, (bySev.get(sev) ?? 0) + 1);
      if (severities.has(sev)) bySvc.set(e.service, (bySvc.get(e.service) ?? 0) + 1);
    }
    return { bySev, bySvc };
  }, [events, hideMetrics, severities, hiddenServices]);

  const visible = useMemo(() => {
    const out: SignalEvent[] = [];
    for (let i = events.length - 1; i >= 0; i--) {
      // 최신이 위로
      const e = events[i]!;
      if (hideMetrics && e.type === 'metric') continue;
      if (!severities.has(severityOf(e))) continue;
      if (hiddenServices.has(e.service)) continue;
      out.push(e);
    }
    return out;
  }, [events, hideMetrics, severities, hiddenServices]);

  // URL 에 아직 나타나지 않은(또는 없는) 서비스 이름이 있어도 실제로 가린 것이 없으면 필터가 걸린 것으로 보지 않는다
  const filtered = severities.size < SEVERITIES.length || timeline.services.some((sv) => hiddenServices.has(sv));
  const resetFilters = () => {
    setSeverities(new Set(SEVERITIES));
    setHiddenServices(new Set());
  };
  const st = STATUS[status];
  const waiting = events.length === 0;
  // error 를 위로, 같은 등급이면 최근에 울린 것을 위로
  const alerts = [...firing.values()].reverse().sort((a, b) => (a.payload.level === b.payload.level ? 0 : a.payload.level === 'error' ? -1 : 1));

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <Logo />
          <h1>Signal Desk</h1>
        </div>
        <div className="topbar-controls">
          <Select label="시나리오" value={scenarioName} options={SCENARIO_OPTIONS} onChange={setScenarioName} />
          <Segmented label="배속" value={speed} options={SPEEDS} onChange={setSpeed} />
        </div>
        <div className="topbar-status">
          <Progress now={timeline.now} total={scenario.durationSec} />
          {/* 연결 상태는 바뀔 때 스크린 리더가 읽도록 status 영역에 둔다. 설명은 숨김 글자로 늘 DOM 에 있고, 마우스는 title 로 본다 */}
          <span role="status" title={st.help}>
            <Badge tone={st.tone} dot pulse={st.pulse}>
              {st.label}
              <VisuallyHidden>. {st.help}</VisuallyHidden>
            </Badge>
          </span>
          <span className="count">
            이벤트 <b>{events.length.toLocaleString()}</b>
            {rejected > 0 && <span className="rejected"> · 거절 {rejected}</span>}
          </span>
        </div>
      </header>

      <main className="layout">
        <Card
          className="area-timeline"
          labelledBy="h-timeline"
          title="p99 지연 타임라인"
          meta={!waiting && `배포 ${timeline.deploys.length} · 경보 ${timeline.spans.length}`}
          actions={
            timeline.services.length > 0 && (
              <ChipGroup
                label="차트에 표시할 서비스"
                chips={timeline.services.map((sv) => ({ id: sv, label: sv, color: colors.get(sv) }))}
                selected={new Set(timeline.services.filter((sv) => !hiddenLines.has(sv)))}
                onChange={(sel) => setHiddenLines((prev) => keepUnseen(prev, timeline.services, sel))}
              />
            )
          }
        >
          {waiting ? (
            <ChartPlaceholder status={status} />
          ) : (
            <Timeline data={timeline} durationSec={scenario.durationSec} tickSec={scenario.tickSec} colors={colors} hidden={hiddenLines} />
          )}
        </Card>

        <div className="area-side">
          <Card
            labelledBy="h-alerts"
            title={
              <>
                발생 중인 경보
                {alerts.length > 0 && <Badge tone={alerts.some((a) => a.payload.level === 'error') ? 'error' : 'warn'}>{alerts.length}</Badge>}
              </>
            }
            className="alerts-card"
            bodyClassName="alerts-body"
          >
            {alerts.length === 0 ? (
              waiting ? (
                <EmptyState title="경보를 기다리는 중" />
              ) : (
                <EmptyState icon={<CheckIcon />} title="발생 중인 경보 없음">
                  모든 서비스가 기준 안에 있습니다
                </EmptyState>
              )
            ) : (
              <ul className="alert-list">
                {alerts.map((a) => (
                  <AlertItem key={a.service} alert={a} events={events} metrics={metrics} origin={origin} now={timeline.now} />
                ))}
              </ul>
            )}
          </Card>

          <Card labelledBy="h-services" title="서비스 상태" meta={timeline.services.length > 0 && `${timeline.services.length}개`} bodyClassName="services-body">
            {timeline.services.length === 0 ? (
              <EmptyState title="서비스 지표를 기다리는 중" />
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">서비스</th>
                    <th scope="col">상태</th>
                    <th scope="col" className="num">
                      p99
                    </th>
                    <th scope="col">추이</th>
                    <th scope="col" className="num">
                      오류율
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {timeline.services.map((sv) => {
                    const alert = firing.get(sv);
                    const p99 = metrics.get(metricKey(sv, 'latency_p99'));
                    const err = metrics.get(metricKey(sv, 'error_rate'));
                    return (
                      <tr key={sv} data-level={alert?.payload.level}>
                        <th scope="row" className="svc-name">
                          <span className="svc-swatch" style={{ background: colors.get(sv) }} aria-hidden="true" />
                          {sv}
                        </th>
                        <td>
                          {alert ? (
                            <Badge tone={alert.payload.level}>{alert.payload.level === 'error' ? '장애' : '주의'}</Badge>
                          ) : (
                            <Badge tone="ok">정상</Badge>
                          )}
                        </td>
                        <td className="num">{p99 ? `${p99.value.toLocaleString()}ms` : '—'}</td>
                        <td>
                          <Sparkline points={timeline.series.get(sv) ?? []} color={colors.get(sv)} total={scenario.durationSec} />
                        </td>
                        {/* 경보 규칙이 없는 지표라도 높은 오류율은 눈에 띄게 한다 (retry-storm 의 함정) */}
                        <td className="num" data-bad={err && err.unit === '%' && err.value >= ERROR_RATE_HIGHLIGHT ? true : undefined}>
                          {err ? `${err.value}${err.unit}` : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </Card>
        </div>

        <Card
          className="area-feed"
          labelledBy="h-events"
          title="이벤트"
          meta={!waiting && (filtered || hideMetrics ? `${visible.length.toLocaleString()} / ${events.length.toLocaleString()}건` : `${events.length.toLocaleString()}건`)}
          actions={
            <Switch isSelected={hideMetrics} onChange={setHideMetrics}>
              지표 숨기기
            </Switch>
          }
          bodyClassName="feed-body"
        >
          <div className="filters" role="group" aria-label="이벤트 필터">
            <ChipGroup
              label="심각도"
              chips={SEVERITIES.map((sv) => ({
                id: sv,
                label: SEVERITY_LABEL[sv],
                tone: sv,
                count: counts.bySev.get(sv) ?? 0,
              }))}
              selected={severities}
              onChange={setSeverities}
            />
            {timeline.services.length > 0 && <span className="filters-sep" aria-hidden="true" />}
            <ChipGroup
              label="서비스"
              chips={timeline.services.map((sv) => ({ id: sv, label: sv, color: colors.get(sv), count: counts.bySvc.get(sv) ?? 0 }))}
              selected={new Set(timeline.services.filter((sv) => !hiddenServices.has(sv)))}
              onChange={(sel) => setHiddenServices((prev) => keepUnseen(prev, timeline.services, sel))}
            />
            {filtered && (
              <button type="button" className="link-button" onClick={resetFilters}>
                필터 초기화
              </button>
            )}
          </div>
          <div className="feed-list">
            {visible.length > 0 ? (
              <>
                <div className="events-head" aria-hidden="true">
                  <span>경과</span>
                  <span>종류</span>
                  <span>서비스</span>
                  <span>내용</span>
                </div>
                <EventList events={visible} virtual origin={origin} />
              </>
            ) : waiting ? (
              <EmptyState icon={<Spinner />} title={status === 'error' ? '서버에 연결하지 못했습니다' : '이벤트를 기다리는 중'}>
                {status === 'error' ? 'SSE 서버가 떠 있는지 확인하세요 (npm run dev:server)' : '첫 이벤트가 오면 최신순으로 쌓입니다'}
              </EmptyState>
            ) : filtered ? (
              <EmptyState title="조건에 맞는 이벤트가 없습니다">
                <button type="button" className="link-button" onClick={resetFilters}>
                  필터 초기화
                </button>
              </EmptyState>
            ) : (
              // 필터는 그대로인데 비었다면 지표만 들어온 상태다. 필터 초기화로는 풀리지 않으니 원인을 그대로 알린다
              <EmptyState title="아직 지표 외 이벤트가 없습니다">
                <button type="button" className="link-button" onClick={() => setHideMetrics(false)}>
                  지표 이벤트 보이기
                </button>
              </EmptyState>
            )}
          </div>
        </Card>
        <InvestigationPanel scenario={scenarioName} />
      </main>
    </div>
  );
}

function AlertItem({
  alert,
  events,
  metrics,
  origin,
  now,
}: {
  alert: AlertEvent;
  events: readonly SignalEvent[];
  metrics: ReturnType<typeof latestMetrics>;
  origin: number;
  now: number;
}) {
  const rule = parseRule(alert.payload.rule);
  const current = rule ? metrics.get(metricKey(alert.service, rule.metric)) : undefined;
  const since = (alert.at.getTime() - origin) / 1000;
  const deploy = lastDeploy(events, alert.service);
  const deployAt = deploy ? (deploy.at.getTime() - origin) / 1000 : undefined;
  const ratio = rule && current && rule.threshold > 0 ? current.value / rule.threshold : undefined;
  const unit = rule?.unit || current?.unit || '';
  return (
    <li className="alert" data-level={alert.payload.level} title={alert.payload.rule}>
      <div className="alert-top">
        <Badge tone={alert.payload.level}>{alert.payload.level === 'error' ? 'ERROR' : 'WARN'}</Badge>
        <span className="alert-svc">{alert.service}</span>
        <span className="alert-since">
          {formatElapsed(since)}부터 · {formatDuration(now - since)}째
        </span>
      </div>
      {rule && current ? (
        <div className="alert-value">
          <span className="alert-metric">{METRIC_LABEL[rule.metric] ?? rule.metric}</span>
          <span className="alert-current">
            {current.value.toLocaleString()}
            <small>{unit}</small>
          </span>
          <span className="alert-threshold">
            / 기준 {rule.threshold.toLocaleString()}
            {unit}
          </span>
          {ratio !== undefined && <span className="alert-ratio">기준의 {ratio.toFixed(1)}배</span>}
        </div>
      ) : (
        // 규칙 모양을 해석하지 못하면 규칙 문자열을 그대로 보여 준다
        <div className="alert-rule">
          <code>{alert.payload.rule}</code>
        </div>
      )}
      {deploy && deployAt !== undefined && deployAt <= since && (
        <div className="alert-deploy">
          직전 배포 <b>{deploy.payload.version}</b> {formatElapsed(deployAt)} ·{' '}
          {since - deployAt < 1 ? '경보와 같은 시각' : `경보 ${formatDuration(since - deployAt)} 전`}
        </div>
      )}
    </li>
  );
}

/**
 * 칩으로 켜고 끈 결과를 "숨긴 서비스" 집합으로 바꾼다.
 * 칩은 지금까지 나타난 서비스만 있으므로, URL 로 받았지만 아직 나타나지 않은 서비스의 숨김은 그대로 둔다
 */
function keepUnseen(prev: ReadonlySet<string>, shown: readonly string[], selected: ReadonlySet<string>): Set<string> {
  const next = new Set([...prev].filter((sv) => !shown.includes(sv)));
  for (const sv of shown) if (!selected.has(sv)) next.add(sv);
  return next;
}

function formatDuration(sec: number) {
  const s = Math.max(0, Math.round(sec));
  return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${s % 60}초`;
}

function Progress({ now, total }: { now: number; total: number }) {
  return (
    <div className="progress" aria-label={`시나리오 진행 ${formatElapsed(now)} / ${formatElapsed(total)}`} role="img">
      <span className="progress-time">{formatElapsed(now)}</span>
      <span className="progress-track" aria-hidden="true">
        <span className="progress-fill" style={{ width: `${Math.min(100, (now / total) * 100)}%` }} />
      </span>
      <span className="progress-total">{formatElapsed(total).slice(2)}</span>
    </div>
  );
}

function Sparkline({ points, color, total }: { points: readonly Point[]; color?: string; total: number }) {
  const W = 72;
  const H = 18;
  if (points.length < 2) return <svg width={W} height={H} aria-hidden="true" />;
  const max = Math.max(...points.map((p) => p.v), 1);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${((p.t / total) * W).toFixed(1)},${(H - 1 - (p.v / max) * (H - 2)).toFixed(1)}`).join('');
  return (
    <svg width={W} height={H} aria-hidden="true" className="spark">
      <path d={d} fill="none" stroke={color} strokeWidth={1.25} strokeLinejoin="round" />
    </svg>
  );
}

function ChartPlaceholder({ status }: { status: StreamStatus }) {
  return (
    <div className="chart-placeholder">
      <svg className="chart-skeleton" viewBox="0 0 600 120" preserveAspectRatio="none" aria-hidden="true">
        <path d="M0,95 C60,92 90,88 130,90 S220,84 260,86 S340,40 380,52 S470,70 520,64 S580,60 600,62" />
      </svg>
      <div className="chart-placeholder-text">
        {status === 'error' ? (
          <EmptyState title="서버에 연결하지 못했습니다">SSE 서버가 떠 있는지 확인하세요</EmptyState>
        ) : (
          <EmptyState icon={<Spinner />} title="스트림에 연결하는 중">
            지표가 들어오면 서비스별 p99 선과 배포·경보 구간이 그려집니다
          </EmptyState>
        )}
      </div>
    </div>
  );
}

function Logo() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <rect width="20" height="20" rx="5" fill="var(--color-text)" />
      <path d="M4 11h3l2-5 2.5 9 2-4H16" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="9" fill="var(--color-ok-bg)" stroke="var(--color-ok-border)" />
      <path d="M6.5 10.2 8.8 12.5 13.5 7.5" fill="none" stroke="var(--color-ok)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}
