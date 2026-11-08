// SSE 이벤트를 받아 React 상태에 쌓는 훅.
// 재연결·중복 제거는 아직 없다(다음 단계). 지금은 연결 한 번의 수명만 다룬다.

import { useEffect, useState } from 'react';
import { connect } from '../client/sse.ts';
import { parseEvent, type SignalEvent } from '../events/schema.ts';

export type StreamStatus = 'connecting' | 'open' | 'closed' | 'error';

export function useSignalStream(url: string) {
  const [events, setEvents] = useState<SignalEvent[]>([]);
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const [rejected, setRejected] = useState(0);

  useEffect(() => {
    const ac = new AbortController();
    setEvents([]);
    setRejected(0);
    setStatus('connecting');

    connect(
      url,
      (msg) => {
        setStatus('open');
        if (msg.event === 'reset') {
          setEvents([]); // 시나리오가 처음부터 다시 시작
          return;
        }
        if (msg.event !== 'signal') return;
        let raw: unknown;
        try {
          raw = JSON.parse(msg.data!);
        } catch {
          setRejected((n) => n + 1);
          return;
        }
        const result = parseEvent(raw); // 네트워크에서 온 값은 스키마를 통과해야 상태에 들어간다
        if (result.ok) setEvents((prev) => [...prev, result.event]);
        else setRejected((n) => n + 1);
      },
      { signal: ac.signal },
    )
      .then(() => setStatus('closed'))
      .catch(() => {
        if (!ac.signal.aborted) setStatus('error');
      });

    // URL 이 바뀌거나 화면이 사라지면 이전 연결을 끊는다. 끊은 뒤 남은 메시지는 connect 가 넘기지 않는다
    return () => ac.abort();
  }, [url]);

  return { events, status, rejected };
}
