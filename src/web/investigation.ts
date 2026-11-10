// 조사 감사 로그(서버 /investigations/:id/stream)를 화면 상태로 바꾼다. React 와 무관한 순수 함수라 브라우저 없이 테스트한다.
// 화면 상태는 이 이벤트들로만 만든다. 다른 사람이 먼저 승인해도 스트림에 결정 이벤트가 오므로 화면이 서버 기록을 따라간다.

import type { Action, AuditEvent, ProposalStatus } from '../audit/store.ts';
import type { Verdict } from '../agent/tools.ts';

export interface InvestigationStep {
  seq: number;
  at: string;
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
}

export interface InvestigationView {
  scenario?: string;
  seed?: number;
  model?: string;
  /** running: 조사 중, proposed: 승인 대기, decided: 거절 또는 실행됨, failed: 결론을 못 냄 */
  phase: 'running' | 'proposed' | 'decided' | 'failed';
  steps: InvestigationStep[];
  verdict?: Verdict;
  proposal?: { id: string; action: Action; status: ProposalStatus; decidedBy?: string; reason?: string };
  failure?: string;
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** SSE data 한 건을 감사 이벤트로. 모양이 다르면 undefined (화면에 넣지 않는다) */
export function parseAuditEvent(data: string | undefined): AuditEvent | undefined {
  try {
    const e = rec(JSON.parse(data ?? ''));
    if (typeof e.seq !== 'number' || typeof e.kind !== 'string' || typeof e.actor !== 'string' || typeof e.at !== 'string') return undefined;
    return e as unknown as AuditEvent;
  } catch {
    return undefined;
  }
}

/** seq 순서로 한 번씩만 반영한다. 재연결로 같은 이벤트가 다시 와도 결과는 같다 */
export function summarizeInvestigation(events: readonly AuditEvent[]): InvestigationView {
  const seen = new Set<number>();
  const ordered = [...events].sort((a, b) => a.seq - b.seq).filter((e) => !seen.has(e.seq) && seen.add(e.seq));
  const v: InvestigationView = { phase: 'running', steps: [] };
  for (const e of ordered) {
    const p = rec(e.payload);
    switch (e.kind) {
      case 'investigation_started':
        v.scenario = String(p.scenario ?? '');
        v.seed = Number(p.seed);
        v.model = String(p.model ?? '');
        break;
      case 'tool_call':
        v.steps.push({ seq: e.seq, at: e.at, tool: String(p.tool ?? ''), args: rec(p.args), result: p.result });
        break;
      case 'verdict':
        v.verdict = {
          service: String(p.service ?? ''),
          kind: p.kind === 'deploy' ? 'deploy' : 'degrade',
          summary: String(p.summary ?? ''),
          // 이전 형식(근거가 문자열 하나)으로 남은 기록도 읽는다
          evidence: Array.isArray(p.evidence)
            ? p.evidence.map((x) => ({ step: Number(rec(x).step), fact: String(rec(x).fact ?? '') }))
            : typeof p.evidence === 'string'
              ? [{ step: 0, fact: p.evidence }]
              : [],
          ruledOut: Array.isArray(p.ruledOut) ? p.ruledOut.map((x) => ({ service: String(rec(x).service ?? ''), why: String(rec(x).why ?? '') })) : [],
        };
        break;
      case 'proposal':
        v.proposal = { id: String(p.proposalId ?? ''), action: rec(p.action) as unknown as Action, status: 'pending' };
        v.phase = 'proposed';
        break;
      case 'decision':
      case 'execution':
        if (!v.proposal || v.proposal.id !== p.proposalId) break;
        v.proposal.status = p.to as ProposalStatus;
        if (e.kind === 'decision') {
          v.proposal.decidedBy = e.actor.replace(/^operator:/, '');
          if (typeof p.reason === 'string') v.proposal.reason = p.reason;
        }
        v.phase = v.proposal.status === 'pending' ? 'proposed' : 'decided';
        break;
      case 'investigation_failed':
        v.phase = 'failed';
        v.failure = String(p.reason ?? '');
        break;
    }
  }
  return v;
}

/** 도구 인자를 한 줄로: get_logs(service: payment-api, limit: 5) */
export function formatCall(step: Pick<InvestigationStep, 'tool' | 'args'>): string {
  const args = Object.entries(step.args).map(([k, val]) => `${k}: ${typeof val === 'string' ? val : JSON.stringify(val)}`);
  return `${step.tool}(${args.join(', ')})`;
}

/** 결과 미리 보기. 배열은 건수, 오류는 메시지, 나머지는 JSON 을 max 글자로 자른다 */
export function previewResult(result: unknown, max = 120): string {
  if (Array.isArray(result)) return `${result.length}건`;
  const r = rec(result);
  if (typeof r.error === 'string') return `오류: ${r.error}`;
  const s = JSON.stringify(result) ?? '';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** 펼친 결과 원문. 배열은 항목 하나를 한 줄로 ({"t":0,"max":405} 가 세로로 늘어지지 않게) */
export function formatResult(result: unknown): string {
  if (Array.isArray(result)) return `[\n${result.map((x) => `  ${JSON.stringify(x)}`).join(',\n')}\n]`;
  const r = rec(result);
  if (Object.keys(r).length > 0 && Object.values(r).some(Array.isArray))
    return `{\n${Object.entries(r).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n')}\n}`;
  return JSON.stringify(result, null, 2) ?? '';
}
