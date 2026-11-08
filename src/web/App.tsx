import { useMemo, useState } from 'react';
import type { SignalEvent } from '../events/schema.ts';
import { useSignalStream, type StreamStatus } from './useSignalStream.ts';
import { EventList, describe, severity } from './EventList.tsx';

const SCENARIOS = ['deploy-regression', 'db-degradation', 'retry-storm'] as const;
const SPEEDS = [1, 5, 20] as const;

const STATUS_LABEL: Record<StreamStatus, string> = {
  connecting: '연결 중',
  open: '수신 중',
  closed: '연결 종료',
  error: '연결 실패',
};

const time = (d: Date) => d.toISOString().slice(11, 19);

export function App() {
  const [scenario, setScenario] = useState<(typeof SCENARIOS)[number]>('deploy-regression');
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(5);
  const [hideMetrics, setHideMetrics] = useState(true);
  const { events, status, rejected } = useSignalStream(`/events?scenario=${scenario}&seed=42&speed=${speed}`);

  // 서비스별 현재 경보와 최근 p99 는 이벤트 목록에서 계산한다 (따로 저장하지 않는다)
  const { firing, latestP99 } = useMemo(() => {
    const firing = new Map<string, SignalEvent>();
    const latestP99 = new Map<string, number>();
    for (const e of events) {
      if (e.type === 'alert') {
        if (e.payload.state === 'firing') firing.set(e.service, e);
        else firing.delete(e.service);
      }
      if (e.type === 'metric' && e.payload.name === 'latency_p99') latestP99.set(e.service, e.payload.value);
    }
    return { firing, latestP99 };
  }, [events]);

  const visible = useMemo(() => {
    const list = hideMetrics ? events.filter((e) => e.type !== 'metric') : events;
    return [...list].reverse(); // 최신이 위로
  }, [events, hideMetrics]);

  return (
    <div className="app">
      <header className="bar">
        <h1>Signal Desk</h1>
        <label>
          시나리오
          <select value={scenario} onChange={(e) => setScenario(e.target.value as typeof scenario)}>
            {SCENARIOS.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          배속
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value) as typeof speed)}>
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}x
              </option>
            ))}
          </select>
        </label>
        <span className={`status status-${status}`}>{STATUS_LABEL[status]}</span>
        <span className="muted">
          이벤트 {events.length}건{rejected > 0 && ` · 스키마 거절 ${rejected}건`}
        </span>
      </header>

      <main className="grid">
        <section className="panel">
          <h2>발생 중인 경보 {firing.size}</h2>
          {firing.size === 0 && <p className="muted">없음</p>}
          <ul className="alerts">
            {[...firing.values()].map((e) => (
              <li key={e.service} className={`sev-${severity(e)}`}>
                <strong>{e.service}</strong>
                <span>{describe(e)}</span>
                <span className="muted">{time(e.at)}부터</span>
              </li>
            ))}
          </ul>

          <h2>서비스 p99</h2>
          <table className="services">
            <tbody>
              {[...latestP99.entries()].map(([service, p99]) => (
                <tr key={service} className={firing.has(service) ? 'hot' : ''}>
                  <td>{service}</td>
                  <td className="num">{p99}ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="panel feed">
          <div className="feed-head">
            <h2>이벤트</h2>
            <label className="muted">
              <input type="checkbox" checked={hideMetrics} onChange={(e) => setHideMetrics(e.target.checked)} /> 지표 숨기기
            </label>
          </div>
          <EventList events={visible} virtual />
        </section>
      </main>
    </div>
  );
}
