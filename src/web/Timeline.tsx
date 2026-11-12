// 타임라인 차트: 서비스별 latency_p99 선 + 배포 세로선 + 경보 구간 띠. 차트 라이브러리 없이 SVG 로 그린다.
// x 축은 시나리오 전체 길이(0 ~ durationSec)로 고정한다. 이벤트가 늘어도 축이 움직이지 않아 "언제" 가 흔들리지 않고,
// reset 으로 이벤트가 비면 선만 사라진다.
// 키보드: 차트에 포커스한 뒤 ←/→ 로 시점을 옮기고 Home/End 로 처음·지금으로 간다. Esc 로 커서를 지운다.

import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { activeSpansAt, formatElapsed, niceMax, parseRule, SEVERITY_LABEL, type AlertSpan, type Timeline as TimelineData } from './derive.ts';
import s from './Timeline.module.css';

const HEIGHT = 0;
const M = { top: 38, right: 60, bottom: 0, left: 104 };
const PLOT_H = 140;
const AXIS_H = 22;
const LANE_H = 14;
const LABEL_ROW_H = 16;

const X_STEPS = [5, 10, 15, 30, 60, 120, 300, 600];

type Props = {
  data: TimelineData;
  durationSec: number;
  tickSec: number;
  colors: ReadonlyMap<string, string>;
  hidden: ReadonlySet<string>;
};

export function Timeline({ data, durationSec, tickSec, colors, hidden }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [cursor, setCursor] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const visibleServices = data.services.filter((sv) => !hidden.has(sv) && data.series.has(sv));
  const laneServices = data.services; // 경보 띠는 선을 숨겨도 남긴다 (경보는 숨기면 안 되는 정보)
  const plotW = Math.max(0, width - M.left - M.right);
  const lanesTop = M.top + PLOT_H + AXIS_H;
  const height = Math.max(HEIGHT, lanesTop + laneServices.length * LANE_H + 8);

  const x = (t: number) => M.left + (Math.min(t, durationSec) / durationSec) * plotW;

  // y 축 최댓값: 보이는 선과 기준선이 모두 들어가게
  const thresholds = useMemo(() => thresholdLines(data.spans), [data.spans]);
  const { yMax, yStep } = useMemo(() => {
    let max = 0;
    for (const sv of visibleServices) for (const p of data.series.get(sv)!) if (p.v > max) max = p.v;
    for (const th of thresholds) if (!hidden.has(th.service) && th.value > max) max = th.value;
    const step = niceMax(Math.max(max, 100) / 4);
    return { yMax: Math.ceil((max * 1.05) / step) * step || step * 4, yStep: step };
  }, [data.series, visibleServices.join(), thresholds, hidden]);
  const y = (v: number) => M.top + PLOT_H - (v / yMax) * PLOT_H;

  const xStep = X_STEPS.find((st) => (plotW / durationSec) * st >= 70) ?? X_STEPS.at(-1)!;
  const xTicks: number[] = [];
  for (let t = 0; t <= durationSec; t += xStep) xTicks.push(t);
  const yTicks: number[] = [];
  for (let v = 0; v <= yMax + 1e-9; v += yStep) yTicks.push(v);

  // 이름표 폭은 그려진 글자 폭을 재서 쓴다. 고정폭 글꼴도 대체 글꼴(SF Mono·Menlo·Consolas)마다 폭이 달라 어림하면 글자가 테두리 밖으로 나간다
  const labelsRef = useRef<SVGGElement>(null);
  const [textW, setTextW] = useState<ReadonlyMap<string, number>>(new Map());
  // 재는 일은 레이아웃을 강제하므로 이름표 글자가 바뀔 때만 한다 (이벤트·커서 이동마다 하지 않는다). 글꼴은 시스템 글꼴뿐이라 글꼴 로딩 뒤 다시 잴 일이 없다
  const labelKey = data.deploys.map(deployLabel).join('\n');
  useLayoutEffect(() => {
    const g = labelsRef.current;
    if (!g) return;
    const measured = [...g.querySelectorAll<SVGTextElement>('text[data-label]')].map((t) => [t.dataset.label!, Math.ceil(t.getComputedTextLength())] as const);
    setTextW((prev) => {
      const changed = measured.filter(([label, w]) => w > 0 && prev.get(label) !== w);
      return changed.length === 0 ? prev : new Map([...prev, ...changed]);
    });
  }, [labelKey]);
  const deployLabels = useMemo(() => layoutDeployLabels(data.deploys, x, plotW, textW), [data.deploys, plotW, durationSec, textW]);

  // 커서는 실제 지표가 있는 시점에 붙인다
  const cursorT = cursor === null ? null : Math.min(cursor, data.now);
  const readings = cursorT === null ? [] : readAt(data, visibleServices, cursorT, tickSec, thresholds);

  const onPointer = (e: PointerEvent<SVGRectElement>) => {
    const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    const t = ((e.clientX - rect.left - M.left) / plotW) * durationSec;
    setCursor(Math.max(0, Math.round(t / tickSec) * tickSec));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const cur = cursorT ?? data.now;
    const map: Record<string, number | null> = {
      ArrowLeft: cur - tickSec,
      ArrowRight: cur + tickSec,
      Home: 0,
      End: data.now,
      Escape: null,
    };
    if (!(e.key in map)) return;
    e.preventDefault();
    const next = map[e.key]!;
    setCursor(next === null ? null : Math.max(0, Math.min(data.now, next)));
  };

  const empty = data.series.size === 0;
  const summary = describeTimeline(data, thresholds);

  return (
    <div
      ref={wrapRef}
      className={s.wrap}
      tabIndex={empty ? -1 : 0}
      role="group"
      aria-roledescription="차트"
      aria-label="서비스별 p99 지연 타임라인. 좌우 화살표로 시점 이동"
      aria-describedby="timeline-summary"
      onKeyDown={onKey}
      onBlur={() => setCursor(null)}
    >
      <p id="timeline-summary" className={s.srOnly}>
        {summary}
      </p>
      {width > 0 && (
        <svg width={width} height={height} className={s.svg} aria-hidden="true">
          {/* 아직 오지 않은 구간은 옅게 칠해 "지금" 이 어디인지 보인다 */}
          {!empty && data.now < durationSec && (
            <rect x={x(data.now)} y={M.top} width={x(durationSec) - x(data.now)} height={PLOT_H} className={s.future} />
          )}

          {/* error 경보 구간은 그래프 바탕에도 옅게 깐다 */}
          {data.spans
            .filter((sp) => sp.level === 'error')
            .map((sp, i) => (
              <rect key={i} x={x(sp.from)} y={M.top} width={Math.max(1, x(sp.to) - x(sp.from))} height={PLOT_H} className={s.errorWash} />
            ))}

          {/* 눈금 */}
          {yTicks.map((v) => (
            <g key={v}>
              <line x1={M.left} x2={M.left + plotW} y1={y(v)} y2={y(v)} className={v === 0 ? s.axisLine : s.gridLine} />
              <text x={M.left - 8} y={y(v)} className={s.yLabel}>
                {v >= 1000 ? `${v / 1000}s` : `${v}ms`}
              </text>
            </g>
          ))}
          {xTicks.map((t) => (
            <g key={t}>
              <line x1={x(t)} x2={x(t)} y1={M.top + PLOT_H} y2={M.top + PLOT_H + 4} className={s.axisLine} />
              <text x={x(t)} y={M.top + PLOT_H + 15} className={s.xLabel}>
                {formatElapsed(t)}
              </text>
            </g>
          ))}

          {/* 경보 기준선 (경보 규칙의 숫자) */}
          {thresholds
            .filter((th) => !hidden.has(th.service) && th.value <= yMax)
            .map((th) => (
              <g key={th.service}>
                <line x1={M.left} x2={M.left + plotW} y1={y(th.value)} y2={y(th.value)} stroke={colors.get(th.service)} className={s.threshold} />
                <text x={M.left + plotW + 6} y={y(th.value)} className={s.thresholdLabel} fill={colors.get(th.service)}>
                  {th.value}ms
                </text>
              </g>
            ))}

          {/* p99 선 */}
          {visibleServices.map((sv) => (
            <path key={sv} d={linePath(data.series.get(sv)!, x, y)} stroke={colors.get(sv)} className={s.line} />
          ))}

          {/* 지금 위치 끝점 */}
          {visibleServices.map((sv) => {
            const pts = data.series.get(sv)!;
            const last = pts.at(-1)!;
            return <circle key={sv} cx={x(last.t)} cy={y(last.v)} r={3} fill={colors.get(sv)} className={s.endDot} />;
          })}

          {/* 배포 세로선과 이름표 */}
          <g ref={labelsRef}>
          {deployLabels.map((d, i) => (
            <g key={i}>
              <line x1={x(d.t)} x2={x(d.t)} y1={d.row * LABEL_ROW_H + 14} y2={lanesTop + laneServices.length * LANE_H} className={s.deployLine} />
              <g transform={`translate(${d.labelX}, ${d.row * LABEL_ROW_H + 2})`}>
                <rect width={d.w} height={13} rx={3} className={s.deployPill} />
                <text x={6} y={9.5} className={s.deployText} data-label={d.label}>
                  <tspan className={s.deployVersion}>{d.version}</tspan> {d.service}
                </text>
              </g>
            </g>
          ))}
          </g>

          {/* 서비스별 경보 띠 */}
          {laneServices.map((sv, i) => {
            const top = lanesTop + i * LANE_H;
            return (
              <g key={sv}>
                <rect x={M.left} y={top + 3} width={plotW} height={LANE_H - 6} rx={2} className={s.laneBg} />
                <text x={M.left - 8} y={top + LANE_H / 2} className={s.laneLabel}>
                  {sv}
                </text>
                {data.spans
                  .filter((sp) => sp.service === sv)
                  .map((sp, j) => (
                    <rect
                      key={j}
                      x={x(sp.from)}
                      y={top + 3}
                      width={Math.max(2, x(sp.to) - x(sp.from))}
                      height={LANE_H - 6}
                      rx={2}
                      className={sp.level === 'error' ? s.spanError : s.spanWarn}
                      data-open={sp.open || undefined}
                    />
                  ))}
              </g>
            );
          })}

          {/* 커서 */}
          {cursorT !== null && (
            <g>
              <line x1={x(cursorT)} x2={x(cursorT)} y1={M.top} y2={lanesTop + laneServices.length * LANE_H} className={s.cursor} />
              {readings.map((r) => (
                <circle key={r.service} cx={x(r.t)} cy={y(r.v)} r={3.5} fill={colors.get(r.service)} className={s.cursorDot} />
              ))}
            </g>
          )}

          {/* 포인터 받는 투명 영역 */}
          {!empty && (
            <rect
              x={M.left}
              y={M.top}
              width={plotW}
              height={lanesTop + laneServices.length * LANE_H - M.top}
              fill="transparent"
              onPointerMove={onPointer}
              onPointerLeave={() => setCursor(null)}
              style={{ pointerEvents: 'all' }}
            />
          )}
        </svg>
      )}

      {cursorT !== null && readings.length > 0 && (
        <div
          className={s.readout}
          style={{
            left: x(cursorT) + (x(cursorT) > width - 220 ? -12 : 12),
            transform: x(cursorT) > width - 220 ? 'translateX(-100%)' : undefined,
          }}
        >
          <div className={s.readoutTime}>{formatElapsed(cursorT)}</div>
          {readings.map((r) => (
            <div key={r.service} className={s.readoutRow}>
              <span className={s.readoutDot} style={{ background: colors.get(r.service) }} />
              <span className={s.readoutSvc}>{r.service}</span>
              <span className={s.readoutVal} data-over={r.over || undefined}>
                {r.v.toLocaleString()}ms
              </span>
            </div>
          ))}
          {activeSpansAt(data.spans, cursorT).map((sp) => (
            <div key={sp.service} className={s.readoutAlert} data-level={sp.level}>
              {sp.service} {SEVERITY_LABEL[sp.level]} 경보
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function linePath(pts: readonly { t: number; v: number }[], x: (t: number) => number, y: (v: number) => number) {
  let d = '';
  for (let i = 0; i < pts.length; i++) d += `${i === 0 ? 'M' : 'L'}${x(pts[i]!.t).toFixed(1)},${y(pts[i]!.v).toFixed(1)}`;
  return d;
}

/** 서비스별 경보 기준값. 같은 서비스에 기준이 여럿이면 가장 최근 것 */
function thresholdLines(spans: readonly AlertSpan[]) {
  const out = new Map<string, { service: string; value: number }>();
  for (const sp of spans) {
    const r = parseRule(sp.rule);
    if (r && r.metric === 'latency_p99' && (r.unit === 'ms' || r.unit === '')) out.set(sp.service, { service: sp.service, value: r.threshold });
  }
  return [...out.values()];
}

/** 배포 이름표가 겹치면 아랫줄로 내린다 (두 줄까지, 그 다음은 다시 윗줄) */
const deployLabel = (d: { version: string; service: string }) => `${d.version} ${d.service}`;

function layoutDeployLabels(deploys: TimelineData['deploys'], x: (t: number) => number, plotW: number, textW: ReadonlyMap<string, number>) {
  const rowEnd = [-Infinity, -Infinity];
  return deploys.map((d) => {
    const label = deployLabel(d);
    // 재기 전(첫 그림)에는 10px 고정폭 글자를 6.2px 로 어림한다. SF Mono 실측 6.18px
    const w = (textW.get(label) ?? label.length * 6.2) + 12;
    let labelX = x(d.t) - 4;
    labelX = Math.min(labelX, M.left + plotW + M.right - w - 2);
    let row = rowEnd.findIndex((end) => labelX > end + 4);
    if (row === -1) row = rowEnd[0]! <= rowEnd[1]! ? 0 : 1;
    rowEnd[row] = labelX + w;
    return { ...d, label, w, labelX, row };
  });
}

function readAt(data: TimelineData, services: readonly string[], t: number, tickSec: number, thresholds: readonly { service: string; value: number }[]) {
  const out: { service: string; t: number; v: number; over: boolean }[] = [];
  const ths = new Map(thresholds.map((th) => [th.service, th.value]));
  for (const sv of services) {
    const pts = data.series.get(sv)!;
    let best: { t: number; v: number } | undefined;
    for (const p of pts) if (Math.abs(p.t - t) <= tickSec / 2 && (!best || Math.abs(p.t - t) < Math.abs(best.t - t))) best = p;
    if (best) out.push({ service: sv, t: best.t, v: best.v, over: ths.has(sv) && best.v > ths.get(sv)! });
  }
  return out.sort((a, b) => b.v - a.v);
}


function describeTimeline(data: TimelineData, thresholds: { service: string; value: number }[]) {
  if (data.series.size === 0) return '아직 받은 지표가 없습니다.';
  const parts = [`${formatElapsed(data.now)}까지`];
  for (const d of data.deploys) parts.push(`${formatElapsed(d.t)} ${d.service} ${d.version} 배포`);
  for (const sp of data.spans) {
    const end = sp.open ? ' 진행 중' : sp.escalated ? ` ${formatElapsed(sp.to)} 등급 상승` : ` ${formatElapsed(sp.to)} 해소`;
    parts.push(`${formatElapsed(sp.from)} ${sp.service} ${SEVERITY_LABEL[sp.level]} 경보${end}`);
  }
  for (const [sv, pts] of data.series) {
    const max = Math.max(...pts.map((p) => p.v));
    const th = thresholds.find((x) => x.service === sv);
    parts.push(`${sv} 최대 ${max}ms${th ? ` (기준 ${th.value}ms)` : ''}`);
  }
  return parts.join('. ') + '.';
}
