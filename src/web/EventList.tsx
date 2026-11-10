// 이벤트 목록. virtual 이 참이면 보이는 줄만 DOM 에 만든다 (TanStack Virtual, ADR-0002).
// 줄 높이는 고정이다. 긴 메시지는 한 줄로 자르고 전체 내용은 title 로 보여 준다.

import { memo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { SignalEvent } from '../events/schema.ts';
import { formatElapsed, severityOf } from './derive.ts';

export const ROW_HEIGHT = 28;
const OVERSCAN = 10;
const PLAIN_STYLE = { height: ROW_HEIGHT };

// origin 이 있으면 시나리오 경과 시간(T+01:05), 없으면 UTC 시각
const stamp = (d: Date, origin?: number) => (origin === undefined ? d.toISOString().slice(11, 19) : formatElapsed((d.getTime() - origin) / 1000));

const TYPE_LABEL: Record<SignalEvent['type'], string> = { metric: '지표', log: '로그', deploy: '배포', alert: '경보' };

export function describe(e: SignalEvent): string {
  switch (e.type) {
    case 'metric':
      return `${e.payload.name} = ${e.payload.value}${e.payload.unit}`;
    case 'log':
      return e.payload.message;
    case 'deploy':
      return `배포 ${e.payload.version} (${e.payload.actor})`;
    case 'alert':
      return `${e.payload.rule} ${e.payload.state === 'firing' ? '발생' : '해소'}`;
  }
}

export const severity = severityOf;

// 같은 이벤트·같은 위치면 다시 그리지 않는다. 비교를 공정하게 하려고 가상화 없는 쪽에도 똑같이 적용된다
const Row = memo(function Row({ e, style, origin, index }: { e: SignalEvent; style?: React.CSSProperties; origin?: number; index?: number }) {
  const text = describe(e);
  const sev = severity(e);
  return (
    <div className={`row sev-${sev}`} style={style} title={text} role="row" aria-rowindex={index === undefined ? undefined : index + 1}>
      <span className="time" role="cell">{stamp(e.at, origin)}</span>
      <span className="type" role="cell">
        <span className="tag" data-sev={sev}>{TYPE_LABEL[e.type]}</span>
      </span>
      <span className="svc" role="cell">{e.service}</span>
      <span className="msg" role="cell">{text}</span>
    </div>
  );
});

export function EventList({ events, virtual, origin, label = '이벤트 목록' }: { events: SignalEvent[]; virtual: boolean; origin?: number; label?: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: virtual ? events.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
  });

  if (!virtual) {
    return (
      <div ref={scrollRef} className="events" data-testid="event-list" role="table" aria-label={label} aria-rowcount={events.length}>
        {/* 모든 줄이 DOM 에 있으므로 aria-rowindex 가 필요 없다. 넘기면 맨 위 삽입 때 모든 줄의 memo 가 깨진다 */}
        {events.map((e) => (
          <Row key={e.id} e={e} style={PLAIN_STYLE} origin={origin} />
        ))}
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="events" data-testid="event-list" role="table" aria-label={label} aria-rowcount={events.length}>
      {/* 스크린 리더는 그려진 줄만 보므로 aria-rowcount·aria-rowindex 로 전체 중 몇 번째인지 알린다 */}
      {/* 전체 높이를 가진 빈 상자로 스크롤바를 만들고, 보이는 줄만 그 위치로 옮겨 그린다 */}
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((item) => {
          const e = events[item.index]!;
          return (
            <Row
              key={e.id}
              e={e}
              origin={origin}
              index={item.index}
              style={{ position: 'absolute', top: 0, left: 0, right: 0, height: ROW_HEIGHT, transform: `translateY(${item.start}px)` }}
            />
          );
        })}
      </div>
    </div>
  );
}
