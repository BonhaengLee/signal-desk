// SSE 이벤트를 받아 React 상태에 쌓는 훅.
// 끊기면 subscribe 가 Last-Event-ID 로 다시 붙고 중복을 거른다. 재연결 대기 중은 'connecting' 으로 보여 준다.
// paused 동안 받은 이벤트는 화면 상태에 넣지 않고 버퍼에 쌓는다. 재생 위치는 서버 시계가 정하므로(src/server/sse.ts positionAt)
// 연결은 유지하고, 재생하면 버퍼를 한 번에 반영해 현재 위치로 따라잡는다. 데모(demoSubscribe)는 재생 시계 자체를 멈춘다.

import { useEffect, useRef, useState } from 'react';
import { subscribe, type SubscribeOptions } from '../client/subscribe.ts';
import { DEMO, demoSubscribe } from './demo.ts';
import { parseEvent, type SignalEvent } from '../events/schema.ts';

// reconnecting: 연결이 끊겨 다시 시도하는 중. subscribe 는 끊으라는 요청이 올 때까지 계속 다시 붙으므로 서버 모드의 실패는 이 상태로 보인다.
// error: 더 시도하지 않고 끝난 실패(데모 파일을 못 읽은 경우 등)
export type StreamStatus = 'connecting' | 'open' | 'reconnecting' | 'closed' | 'error';

/** 멈춘 동안 받은 것. reset 이 왔으면 화면의 이벤트를 비우고 events 로 바꿔야 한다 */
export type Held = { readonly reset: boolean; readonly events: readonly SignalEvent[] };
export const EMPTY_HELD: Held = { reset: false, events: [] };

/** 멈춘 동안 온 메시지 하나를 버퍼에 넣는다. reset 이 오면 그 전 버퍼는 반영할 일이 없어 비운다 (버퍼 크기는 최대 한 바퀴) */
export function holdMessage(held: Held, msg: { reset: true } | { event: SignalEvent }): Held {
  if ('reset' in msg) return { reset: true, events: [] };
  return { reset: held.reset, events: [...held.events, msg.event] };
}

/** 버퍼를 화면 이벤트에 반영한다. 버퍼가 비었으면 같은 배열을 돌려줘 리렌더하지 않게 한다 */
export function releaseHeld(current: SignalEvent[], held: Held): SignalEvent[] {
  if (held.reset) return [...held.events];
  return held.events.length === 0 ? current : [...current, ...held.events];
}

export function useSignalStream(url: string, paused = false) {
  const [events, setEvents] = useState<SignalEvent[]>([]);
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const [rejected, setRejected] = useState(0);
  const [attempt, setAttempt] = useState(0); // 재연결 시도 횟수. 연결되면 0
  const [pending, setPending] = useState(0); // 버퍼에 쌓인 이벤트 수 (reset 뒤 것만)
  // 메시지 콜백은 연결할 때 한 번 만들어지므로 멈춤 여부와 버퍼는 ref 로 읽는다. 멈춤을 바꿔도 다시 연결하지 않는다
  const pausedRef = useRef(paused);
  const heldRef = useRef<Held>(EMPTY_HELD);

  useEffect(() => {
    const ac = new AbortController();
    setEvents([]);
    setRejected(0);
    setStatus('connecting');
    setAttempt(0);
    heldRef.current = EMPTY_HELD;
    setPending(0);

    const hold = (msg: Parameters<typeof holdMessage>[1]) => {
      heldRef.current = holdMessage(heldRef.current, msg);
      setPending(heldRef.current.events.length);
    };

    const opts: SubscribeOptions = {
      signal: ac.signal,
      onStatus: (s, detail) => {
        if (s === 'open') {
          setStatus('open');
          setAttempt(0);
        } else if (s === 'reconnecting') {
          setStatus('reconnecting');
          setAttempt(detail?.attempt ?? 0);
        } else if (s === 'connecting') setStatus('connecting');
        else if (!ac.signal.aborted) setStatus('closed');
      },
      onMessage: (msg) => {
        if (msg.event === 'snapshot') {
          // 데모가 재생 위치를 옮겼다 (demoSeek). 그 시점까지의 이벤트로 화면을 바꾼다.
          // 옮긴 위치를 보려고 누른 것이라 멈춰 있어도 바로 반영하고, 그 전에 쌓인 버퍼는 버린다
          let list: unknown;
          try {
            list = JSON.parse(msg.data!);
          } catch {
            setRejected((n) => n + 1);
            return;
          }
          const ok: SignalEvent[] = [];
          let bad = 0;
          for (const raw of Array.isArray(list) ? list : []) {
            const r = parseEvent(raw);
            if (r.ok) ok.push(r.event);
            else bad++;
          }
          heldRef.current = EMPTY_HELD;
          setPending(0);
          setEvents(ok);
          if (bad > 0) setRejected((n) => n + bad);
          return;
        }
        if (msg.event === 'reset') {
          // 시나리오가 처음부터 다시 시작
          if (pausedRef.current) hold({ reset: true });
          else setEvents([]);
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
        if (!result.ok) setRejected((n) => n + 1);
        else if (pausedRef.current) hold({ event: result.event });
        else setEvents((prev) => [...prev, result.event]);
      },
    };
    // 데모는 멈춘 동안 재생 시계도 세우므로 버퍼에 쌓일 것이 없다. 서버 모드는 서버 시계를 못 세워서 버퍼로 따라잡는다
    (DEMO ? demoSubscribe(url, opts, () => pausedRef.current) : subscribe(url, opts)).catch(() => {
      if (!ac.signal.aborted) setStatus('error');
    });

    // URL 이 바뀌거나 화면이 사라지면 이전 연결을 끊는다. 끊은 뒤 남은 메시지는 connect 가 넘기지 않는다
    return () => ac.abort();
  }, [url]);

  // 연결 효과보다 뒤에 둔다. 멈춘 채 URL 이 바뀌면 연결 효과가 버퍼를 먼저 비우므로 이전 스트림의 버퍼를 넣지 않는다
  useEffect(() => {
    pausedRef.current = paused;
    if (paused) return;
    const held = heldRef.current;
    heldRef.current = EMPTY_HELD;
    setPending(0);
    if (held !== EMPTY_HELD) setEvents((prev) => releaseHeld(prev, held));
  }, [paused]);

  return { events, status, attempt, rejected, pending };
}
