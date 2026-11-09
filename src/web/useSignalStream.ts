// SSE 이벤트를 받아 React 상태에 쌓는 훅.
// 끊기면 subscribe 가 Last-Event-ID 로 다시 붙고 중복을 거른다. 재연결 대기 중은 'connecting' 으로 보여 준다.

import { useEffect, useState } from 'react';
import { subscribe } from '../client/subscribe.ts';
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

    subscribe(url, {
      signal: ac.signal,
      onStatus: (s) => {
        if (s === 'open') setStatus('open');
        else if (s === 'connecting' || s === 'reconnecting') setStatus('connecting');
        else if (!ac.signal.aborted) setStatus('closed');
      },
      onMessage: (msg) => {
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
    }).catch(() => {
      if (!ac.signal.aborted) setStatus('error');
    });

    // URL 이 바뀌거나 화면이 사라지면 이전 연결을 끊는다. 끊은 뒤 남은 메시지는 connect 가 넘기지 않는다
    return () => ac.abort();
  }, [url]);

  return { events, status, rejected };
}
