// SSE 구독: 끊기면 다시 붙고, 마지막으로 받은 id 다음부터 이어 받고, 이미 받은 메시지는 거른다.
// 서버는 Last-Event-ID 다음부터 보내 주지만, 그 약속이 깨져도(프록시 재전송 등) 화면에 중복이 생기지 않게 클라이언트에서도 거른다.

import { connect, type SseMessage } from './sse.ts';

export type SubscribeStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface SubscribeOptions {
  signal: AbortSignal;
  onMessage: (msg: SseMessage) => void;
  onStatus?: (status: SubscribeStatus, detail?: { attempt: number; delayMs: number }) => void;
  baseDelayMs?: number; // 첫 재연결 대기
  maxDelayMs?: number; // 대기 상한
  idleTimeoutMs?: number; // 이 시간 동안 하트비트조차 오지 않으면 죽은 연결로 보고 다시 붙는다
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>; // 테스트에서 바꿔 끼운다
}

/** 'cycle:seq' 를 비교 가능한 쌍으로. 형식이 다르면 undefined (거르지 않는다) */
function order(id: string | undefined): [number, number] | undefined {
  const m = /^(\d+):(\d+)$/.exec(id ?? '');
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}

const after = (a: [number, number], b: [number, number]) => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

/** 지수 백오프: 1s, 2s, 4s … 상한에서 멈춘다. 메시지를 하나라도 받으면 처음으로 돌아간다 */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * 2 ** (attempt - 1));
}

export async function subscribe(url: string, opts: SubscribeOptions): Promise<void> {
  const { signal, onMessage, onStatus } = opts;
  const base = opts.baseDelayMs ?? 1000;
  const max = opts.maxDelayMs ?? 15_000;
  const sleep = opts.sleep ?? defaultSleep;
  const idleMs = opts.idleTimeoutMs ?? 45_000; // 서버 하트비트 15초의 3배
  let lastId: string | undefined;
  let last: [number, number] | undefined;
  let attempt = 0;

  onStatus?.('connecting');
  while (!signal.aborted) {
    let received = false;
    // 시도마다 따로 끊을 수 있게 한다. 바깥에서 끊으면 같이 끊긴다
    const attempt$ = new AbortController();
    const forward = () => attempt$.abort();
    signal.addEventListener('abort', forward);
    let idle: ReturnType<typeof setTimeout> | undefined;
    const kick = () => {
      clearTimeout(idle);
      idle = setTimeout(() => attempt$.abort(), idleMs); // 프록시가 끊김을 숨겨도 조용하면 끊는다
    };
    kick();
    try {
      await connect(
        url,
        (msg) => {
          if (!received) {
            received = true;
            attempt = 0;
            onStatus?.('open');
          }
          const pos = order(msg.id);
          if (pos && last && !after(pos, last)) return; // 이미 받은 것
          if (pos) {
            last = pos;
            lastId = msg.id;
          }
          onMessage(msg);
        },
        { signal: attempt$.signal, headers: lastId ? { 'Last-Event-ID': lastId } : {} },
        kick,
      );
    } catch {
      // 네트워크 오류·HTTP 오류·조용한 연결 모두 재연결 대상. 끊으라는 요청이면 아래에서 빠져나간다
    } finally {
      clearTimeout(idle);
      signal.removeEventListener('abort', forward);
    }
    if (signal.aborted) break;
    attempt += 1;
    const delayMs = backoffDelay(attempt, base, max);
    onStatus?.('reconnecting', { attempt, delayMs });
    await sleep(delayMs, signal);
  }
  onStatus?.('closed');
}
