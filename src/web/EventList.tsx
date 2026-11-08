// 이벤트 목록. virtual 이 참이면 보이는 줄만 DOM 에 만든다 (TanStack Virtual, ADR-0002).
// 줄 높이는 고정이다. 긴 메시지는 한 줄로 자르고 전체 내용은 title 로 보여 준다.

import { memo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { SignalEvent } from '../events/schema.ts';

export const ROW_HEIGHT = 26;
const OVERSCAN = 10;
const PLAIN_STYLE = { height: ROW_HEIGHT };

const time = (d: Date) => d.toISOString().slice(11, 19);

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

export function severity(e: SignalEvent): string {
  if (e.type === 'log' || e.type === 'alert') return e.payload.level;
  if (e.type === 'deploy') return 'deploy';
  return 'info';
}

// 같은 이벤트·같은 위치면 다시 그리지 않는다. 비교를 공정하게 하려고 가상화 없는 쪽에도 똑같이 적용된다
const Row = memo(function Row({ e, style }: { e: SignalEvent; style?: React.CSSProperties }) {
  const text = describe(e);
  return (
    <div className={`row sev-${severity(e)}`} style={style} title={text}>
      <span className="muted">{time(e.at)}</span>
      <span className="type">{e.type}</span>
      <span className="svc">{e.service}</span>
      <span className="msg">{text}</span>
    </div>
  );
});

export function EventList({ events, virtual }: { events: SignalEvent[]; virtual: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: virtual ? events.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
  });

  if (!virtual) {
    return (
      <div ref={scrollRef} className="events" data-testid="event-list">
        {events.map((e) => (
          <Row key={e.id} e={e} style={PLAIN_STYLE} />
        ))}
      </div>
    );
  }

  return (
    <div ref={scrollRef} className="events" data-testid="event-list">
      {/* 전체 높이를 가진 빈 상자로 스크롤바를 만들고, 보이는 줄만 그 위치로 옮겨 그린다 */}
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((item) => {
          const e = events[item.index]!;
          return (
            <Row
              key={e.id}
              e={e}
              style={{ position: 'absolute', top: 0, left: 0, right: 0, height: ROW_HEIGHT, transform: `translateY(${item.start}px)` }}
            />
          );
        })}
      </div>
    </div>
  );
}
