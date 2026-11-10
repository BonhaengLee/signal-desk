// 조사 에이전트 루프. 모델이 도구를 부르면 실행해 결과를 대화에 붙이고, submit_root_cause 가 나오면 끝낸다.
// Chat Completions 는 상태가 없어서 매 턴 대화 전체를 다시 보낸다

import { parseVerdict, runTool, toolSpecsFor, type ToolContext, type ToolSpec, type Verdict } from './tools.ts';

export interface ToolCall {
  id: string;
  function: { name: string; arguments: string };
}
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
/** 모델 한 번 호출. 테스트에서는 각본대로 답하는 가짜로 바꾼다 */
export type ChatFn = (messages: ChatMessage[], tools: ToolSpec[]) => Promise<ChatMessage>;

export interface Step {
  tool: string;
  args: Record<string, unknown>;
}
export interface InvestigateOptions {
  maxSteps?: number; // 모델 호출 상한
  onStep?: (step: Step, result: unknown) => void; // 도구를 실행할 때마다. 감사 로그·화면 스트리밍용
}

export interface InvestigateResult {
  verdict?: Verdict;
  steps: Step[];
  stopReason: 'submitted' | 'max_steps' | 'no_tool_call';
}

const SYSTEM = `장애 조사 에이전트다. 도구로 증거를 모아 근본 원인 서비스 하나와 종류(deploy/degrade)를 제출한다.
- 경보가 먼저 울린 곳이 원인이라고 단정하지 않는다. 호출 관계상 아래쪽(의존 대상)을 확인한다
- 배포가 있었다고 원인이라고 단정하지 않는다. 지표가 배포 시점 직후에 나빠졌는지 시각을 비교한다
- 증상 이후의 배포는 원인이 될 수 없다
- 확인이 끝나면 submit_root_cause 를 한 번 호출한다`;

export async function investigate(ctx: ToolContext, chat: ChatFn, { maxSteps = 10, onStep }: InvestigateOptions = {}): Promise<InvestigateResult> {
  const known = new Set(ctx.topology.services.map((s) => s.name));
  const specs = toolSpecsFor(ctx);
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `${ctx.topology.entry} 응답 지연 장애. 원인을 조사해.` },
  ];
  const steps: Step[] = [];
  let nudged = false;

  for (let turn = 0; turn < maxSteps; turn++) {
    const reply = await chat(messages, specs);
    messages.push(reply);
    const calls = reply.tool_calls ?? [];
    if (calls.length === 0) {
      // 도구 없이 말로만 답하면 한 번만 다시 요구한다
      if (nudged) return { steps, stopReason: 'no_tool_call' };
      nudged = true;
      messages.push({ role: 'user', content: '결론은 submit_root_cause 도구로 제출해.' });
      continue;
    }
    for (const call of calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch {
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: '인자가 JSON 이 아님' }) });
        continue;
      }
      steps.push({ tool: call.function.name, args });
      if (call.function.name === 'submit_root_cause') {
        const v = parseVerdict(args, known);
        onStep?.(steps.at(-1)!, v.ok ? { ok: true } : { error: v.error });
        if (v.ok) return { verdict: v.verdict, steps, stopReason: 'submitted' };
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: v.error }) });
        continue;
      }
      const result = runTool(ctx, call.function.name, args);
      onStep?.(steps.at(-1)!, result);
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  return { steps, stopReason: 'max_steps' };
}

/** OpenAI 호환 엔드포인트용 ChatFn */
// 무료 엔드포인트는 429·503 이 잦다. 같은 모델로 5·10·20·40·60초 기다렸다 다시 부른다.
// 다른 모델로 넘기지 않는 이유: 한 조사 안에서 모델이 바뀌면 평가 결과를 어느 모델 몫으로 볼지 모호해진다
const RETRY_DELAYS_MS = [5000, 10000, 20000, 40000, 60000];

export function openAiChat(baseUrl: string, apiKey: string, model: string, timeoutMs = 60_000): ChatFn {
  return async (messages, tools) => {
    let res: Response;
    for (let i = 0; ; i++) {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, tools, temperature: 0 }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || i >= RETRY_DELAYS_MS.length) break;
      await res.body?.cancel();
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[i]));
    }
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { choices?: { message?: ChatMessage }[] };
    const msg = body.choices?.[0]?.message;
    if (!msg) throw new Error('LLM 응답에 message 없음');
    return { role: 'assistant', content: msg.content ?? null, tool_calls: msg.tool_calls };
  };
}
