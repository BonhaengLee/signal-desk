// 조사 한 건을 실행하고 모든 단계를 감사 로그에 남긴다. 결론이 나면 조치를 "제안"만 하고 실행은 사람의 승인을 기다린다

import type { AuditStore, Action } from '../audit/store.ts';
import type { SignalEvent } from '../events/schema.ts';
import { investigate, type ChatFn } from './agent.ts';
import type { Judgement, ToolContext } from './tools.ts';

/** 결론 → 조치. deploy 탓이면 그 서비스의 마지막 배포를 되돌리고, 아니면 담당자를 호출한다 */
export function proposeAction(verdict: Judgement, events: SignalEvent[]): Action {
  if (verdict.kind === 'deploy') {
    const last = events.filter((e) => e.type === 'deploy' && e.service === verdict.service).at(-1);
    const version = last?.type === 'deploy' ? last.payload.version : undefined;
    return { type: 'rollback', service: verdict.service, ...(version ? { version } : {}) };
  }
  return { type: 'escalate', service: verdict.service };
}

export async function runInvestigation(store: AuditStore, id: string, ctx: ToolContext, chat: ChatFn): Promise<void> {
  try {
    const r = await investigate(ctx, chat, {
      onStep: (step, result) => store.append(id, 'agent', 'tool_call', { ...step, result }),
    });
    if (!r.verdict) {
      store.append(id, 'system', 'investigation_failed', { reason: r.stopReason, steps: r.steps.length });
      return;
    }
    store.append(id, 'agent', 'verdict', r.verdict);
    store.propose(id, proposeAction(r.verdict, ctx.events));
  } catch (e) {
    store.append(id, 'system', 'investigation_failed', { reason: (e as Error).message.slice(0, 200) });
  }
}
