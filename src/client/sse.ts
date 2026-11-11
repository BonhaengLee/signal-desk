// SSE 파서 (손으로 짠 코드). React 와 무관한 순수 함수라 브라우저 없이 테스트한다.
// 규칙은 HTML 표준 "Server-sent events" 절을 따른다.
// 알려진 한계: 줄바꿈은 \n 만 처리한다(\r\n, \r 미지원). ':' 가 없는 줄, ':' 뒤 공백이 없는 줄은 표준과 다르게 읽힌다.

export type SseMessage = { event: string; id?: string; data?: string; retry?: string; [field: string]: string | undefined };

/** 완성된 메시지 블록 하나(빈 줄 제외)를 필드 객체로 바꾼다 */
export function parseMessage(block: string): SseMessage {
  const msg = block.split('\n').reduce<Record<string, string>>((acc, line) => {
    const i = line.indexOf(':');
    if (i === 0) return acc; // ':' 로 시작하면 주석 (하트비트)
    const key = line.slice(0, i);
    const value = line.slice(i + 2);
    if (key === 'data' && acc.data !== undefined) return { ...acc, data: acc.data + '\n' + value };
    return { ...acc, [key]: value };
  }, {});
  return { event: 'message', ...msg }; // event 가 없으면 표준 기본값 message
}

/** 쌓인 텍스트를 빈 줄로 나눈다. 마지막 칸은 아직 끝나지 않은 부분이다 */
export function splitMessages(buffer: string): { blocks: string[]; rest: string } {
  const parts = buffer.split('\n\n');
  const rest = parts.pop()!;
  return { blocks: parts, rest };
}

/** 서버가 스트림 대신 HTTP 오류로 답했다. subscribe 가 다시 시도할지 status 로 고른다 */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`SSE 연결 실패: HTTP ${status}`);
    this.status = status;
  }
}

/** 스트림을 읽어 메시지가 완성될 때마다 onMessage 를 부른다. onActivity 는 하트비트 주석을 포함해 바이트가 올 때마다 불린다 */
export async function connect(
  url: string,
  onMessage: (msg: SseMessage) => void,
  init: RequestInit = {},
  onActivity?: () => void,
): Promise<void> {
  const res = await fetch(url, init);
  if (!res.ok || !res.body) throw new HttpError(res.status);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    onActivity?.();
    buffer += decoder.decode(value, { stream: true }); // 조각 경계에서 잘린 한글 바이트를 다음 조각과 합친다
    const { blocks, rest } = splitMessages(buffer);
    buffer = rest;
    for (const block of blocks) {
      // 한 조각에 메시지가 여러 개 들어 있을 수 있다. 도중에 끊으라는 요청이 오면 남은 것은 넘기지 않는다
      if (init.signal?.aborted) return;
      const msg = parseMessage(block);
      if (msg.data === undefined) continue; // data 가 없으면 메시지가 아니다 (주석만 있는 블록 등)
      onMessage(msg);
    }
  }
}
