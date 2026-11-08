// 목록 렌더링 측정 페이지: /?bench&n=10000
// 같은 EventList 를 가상화 없이/있이 그려서, 처음 그리기와 새 이벤트 1건 추가에 걸린 시간을 잰다.
// flushSync 로 렌더를 동기로 끝낸 뒤 레이아웃을 강제로 계산시켜 "화면에 배치되기까지"를 포함한다 (페인트는 제외).

import { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { simulate, type Scenario } from '../simulator/simulate.ts';
import type { SignalEvent } from '../events/schema.ts';
import { EventList } from './EventList.tsx';
import deployRegression from '../../scenarios/deploy-regression.json';
import dbDegradation from '../../scenarios/db-degradation.json';
import retryStorm from '../../scenarios/retry-storm.json';

const SCENARIOS = [deployRegression, dbDegradation, retryStorm] as unknown as Scenario[];
const REPEAT = 5;
const APPENDS = 30;

function makeEvents(n: number): SignalEvent[] {
  const out: SignalEvent[] = [];
  for (let seed = 1; ; seed++) {
    for (const sc of SCENARIOS) {
      for (const e of simulate(sc, seed)) {
        out.push({ ...e, id: `${sc.name}-${e.id}` });
        if (out.length === n) return out;
      }
    }
  }
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const layout = () => document.querySelector('[data-testid="event-list"]')?.getBoundingClientRect();
// 탭이 가려지면 requestAnimationFrame 이 멈추므로 setTimeout 으로 이벤트 루프에 한 번 양보한다
const nextFrame = () => new Promise((r) => setTimeout(r, 0));

type Result = { mode: string; n: number; mountMs: number; appendMs: number; domRows: number };

export function Bench() {
  const n = Number(new URLSearchParams(location.search).get('n') ?? 10000);
  const [state, setState] = useState<{ virtual: boolean; events: SignalEvent[] } | null>(null);
  const [results, setResults] = useState<Result[]>([]);

  useEffect(() => {
    const all = makeEvents(n + APPENDS);
    const base = all.slice(0, n);
    const extra = all.slice(n);
    (async () => {
      const out: Result[] = [];
      for (const virtual of [false, true]) {
        const mounts: number[] = [];
        const appends: number[] = [];
        let domRows = 0;
        for (let r = 0; r < REPEAT; r++) {
          flushSync(() => setState(null));
          await nextFrame();
          let t0 = performance.now();
          flushSync(() => setState({ virtual, events: base }));
          layout();
          mounts.push(performance.now() - t0);
          domRows = document.querySelectorAll('[data-testid="event-list"] .row').length;
          await nextFrame();
          if (r === 0) {
            // 실시간 유입처럼 1건씩 맨 위에 붙인다
            for (const e of extra) {
              t0 = performance.now();
              flushSync(() => setState((s) => s && { ...s, events: [e, ...s.events] }));
              layout();
              appends.push(performance.now() - t0);
              await nextFrame();
            }
          }
        }
        out.push({ mode: virtual ? 'TanStack Virtual' : '가상화 없음', n, mountMs: median(mounts), appendMs: median(appends), domRows });
      }
      flushSync(() => setState(null));
      setResults(out);
      (window as unknown as { __bench: Result[] }).__bench = out;
    })();
  }, [n]);

  return (
    <div style={{ padding: 16, display: 'grid', gap: 12, height: '100vh', gridTemplateRows: 'auto 1fr' }}>
      <pre id="bench-result" style={{ margin: 0 }}>
        {results.length === 0
          ? `측정 중… (${n}건, 처음 그리기 중앙값 ${REPEAT}회, 1건 추가 중앙값 ${APPENDS}회)`
          : results
              .map((r) => `${r.mode.padEnd(16)} 처음 그리기 ${r.mountMs.toFixed(1)}ms · 1건 추가 ${r.appendMs.toFixed(1)}ms · DOM 줄 ${r.domRows}개`)
              .join('\n')}
      </pre>
      <div style={{ display: 'flex', minHeight: 0, height: 600 }}>{state && <EventList events={state.events} virtual={state.virtual} />}</div>
    </div>
  );
}
