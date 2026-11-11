// 조사 한 건의 감사 로그 스트림을 받아 화면 상태로 바꾸는 훅과, 조사 시작·승인 요청.
// 끊기면 subscribe 가 Last-Event-ID(= seq) 다음부터 이어 받고, 중복은 summarizeInvestigation 이 seq 로 거른다.

import { useEffect, useMemo, useState } from 'react';
import type { AuditEvent } from '../audit/store.ts';
import { subscribe, type SubscribeOptions } from '../client/subscribe.ts';
import { DEMO, DemoError, demoDecide, demoReadyAt, demoStart, demoSubscribe } from './demo.ts';
import { parseAuditEvent, summarizeInvestigation, type InvestigationView } from './investigation.ts';

// error: 끊겨서 다시 붙는 중. notFound·failed: 다시 시도하지 않고 끝난 실패 (없는 조사 id, 데모 파일을 못 읽음 등)
export type InvestigationStreamStatus = 'connecting' | 'open' | 'error' | 'notFound' | 'failed';

export function useInvestigation(id: string | undefined): { view?: InvestigationView; status: InvestigationStreamStatus } {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [status, setStatus] = useState<InvestigationStreamStatus>('connecting');

  useEffect(() => {
    setEvents([]);
    setStatus('connecting');
    if (!id) return;
    const ac = new AbortController();
    const url = `/investigations/${id}/stream`;
    const opts: SubscribeOptions = {
      signal: ac.signal,
      onStatus: (s) => setStatus(s === 'open' ? 'open' : s === 'reconnecting' ? 'error' : 'connecting'),
      onMessage: (msg) => {
        const e = parseAuditEvent(msg.data);
        if (e) setEvents((prev) => [...prev, e]);
      },
    };
    // 조사 녹화는 재생을 멈춰도 계속 나온다 (조사를 누르면 화면이 자동으로 멈추기 때문)
    (DEMO ? demoSubscribe(url, opts, () => false) : subscribe(url, opts)).catch((e: unknown) => {
      if (!ac.signal.aborted) setStatus((e as { status?: number }).status === 404 ? 'notFound' : 'failed');
    });
    return () => ac.abort();
  }, [id]);

  const view = useMemo(() => (id && events.length > 0 ? summarizeInvestigation(events) : undefined), [id, events]);
  return { view, status };
}

/** 조사를 시작할 수 있는 시점(초). 서버 모드는 언제나 0. 데모는 녹화 시점이고, 읽는 중이면 undefined, 녹화가 없거나 못 읽으면 null */
export function useReadyAt(scenario: string): number | null | undefined {
  const [readyAt, setReadyAt] = useState<number | null | undefined>(DEMO ? undefined : 0);
  useEffect(() => {
    if (!DEMO) return;
    let live = true;
    setReadyAt(undefined);
    demoReadyAt(scenario).then(
      (sec) => live && setReadyAt(sec ?? null),
      () => live && setReadyAt(null),
    );
    return () => {
      live = false;
    };
  }, [scenario]);
  return readyAt;
}

/** 요청 실패를 화면 문장으로. 조사 API 가 꺼져 있으면 서버가 404 를 준다 (LLM 키가 없을 때) */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function post(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `HTTP ${res.status}`);
  return data;
}

/** 데모 오류를 서버 오류와 같은 모양으로 */
async function demoCall<T>(f: () => T | Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    throw e instanceof DemoError ? new ApiError(e.status, e.message) : e;
  }
}

export async function startInvestigation(scenario: string, seed: number, atSec: number): Promise<string> {
  if (DEMO) return demoCall(() => demoStart(scenario, atSec));
  const r = (await post('/investigations', { scenario, seed, atSec })) as { id: string };
  return r.id;
}

export async function decideProposal(proposalId: string, operator: string, decision: 'approved' | 'rejected', reason?: string): Promise<void> {
  if (DEMO) return demoCall(() => demoDecide(proposalId, operator, decision, reason));
  await post(`/proposals/${proposalId}/decision`, { operator, decision, ...(reason ? { reason } : {}) });
}
