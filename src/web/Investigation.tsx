// 조사 패널: 에이전트가 부른 도구가 순서대로 쌓이고, 결론과 조치 제안이 나오면 사람이 승인하거나 거절한다.
// 상태는 서버 감사 로그 스트림에서만 만든다 (investigation.ts). 버튼을 누른 결과도 스트림으로 돌아와 화면에 반영된다.

import { useEffect, useId, useState, type FormEvent } from 'react';
import type { Action } from '../audit/store.ts';
import type { Verdict } from '../agent/tools.ts';
import { formatCall, formatResult, previewResult, type InvestigationView } from './investigation.ts';
import { formatElapsed } from './derive.ts';
import { ApiError, decideProposal, startInvestigation, useInvestigation } from './useInvestigation.ts';
import { DEMO } from './demo.ts';
import { Badge, Button, Card, EmptyState, VisuallyHidden, type Tone } from './ui/controls.tsx';
import s from './Investigation.module.css';

const SEED = 42; // 화면 스트림(/events)과 같은 시드. 에이전트가 화면과 같은 사건을 조사한다
const OPERATOR_RE = /^[\w.-]{1,40}$/; // 서버 규칙과 같다 (src/audit/store.ts decide)
const OPERATOR_KEY = 'signal-desk.operator';

const TOOL_LABEL: Record<string, string> = {
  get_topology: '호출 관계',
  list_alerts: '경보 목록',
  list_deploys: '배포 목록',
  get_metric: '지표',
  get_logs: '로그',
  get_service_metrics: '서비스 지표',
  rank_anomalies: '이상 순위',
  submit_root_cause: '결론 제출',
};

const PHASE: Record<InvestigationView['phase'], { label: string; tone: Tone }> = {
  running: { label: '조사 중', tone: 'info' },
  proposed: { label: '승인 대기', tone: 'warn' },
  decided: { label: '결정됨', tone: 'neutral' },
  failed: { label: '결론 없음', tone: 'error' },
};

/** URL 의 ?inv= 를 읽고 쓴다. 다른 쿼리는 그대로 둔다 */
function readInv(): string | undefined {
  return new URLSearchParams(location.search).get('inv') ?? undefined;
}
function writeInv(id: string | undefined) {
  const q = new URLSearchParams(location.search);
  if (id) q.set('inv', id);
  else q.delete('inv');
  const qs = q.toString();
  history.replaceState(history.state, '', `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`);
}

/**
 * scenario: 화면이 재생 중인 시나리오. nowSec: 지금 재생 위치(시나리오 경과 초). alerted: 이번 재생에서 경보가 한 번이라도 울렸는가.
 * 조사는 nowSec 까지의 기록만 본다. 경보가 울리기 전에는 조사할 대상이 없어 버튼을 끈다
 * onStart: 누르는 순간 부른다(화면 재생을 멈춤). 시작에 실패하면 돌려받은 함수를 불러 되돌린다
 */
export function InvestigationPanel({
  scenario,
  nowSec,
  alerted,
  onStart,
}: {
  scenario: string;
  nowSec: number;
  alerted: boolean;
  onStart: () => () => void;
}) {
  const [id, setId] = useState(readInv);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string>();
  const { view, status } = useInvestigation(id);

  useEffect(() => writeInv(id), [id]);

  const start = async () => {
    const atSec = Math.floor(nowSec);
    const undo = onStart();
    setStarting(true);
    setError(undefined);
    try {
      setId(await startInvestigation(scenario, SEED, atSec));
    } catch (e) {
      undo();
      setError(
        e instanceof ApiError && e.status === 404 && !DEMO
          ? '조사 API 가 꺼져 있습니다. .env.local 에 LLM 키를 넣고 서버를 다시 켜세요'
          : `조사를 시작하지 못했습니다: ${(e as Error).message}`,
      );
    } finally {
      setStarting(false);
    }
  };

  const phase = view ? PHASE[view.phase] : undefined;
  return (
    <Card
      labelledBy="h-investigation"
      title={
        <>
          조사
          {phase && <Badge tone={phase.tone}>{phase.label}</Badge>}
        </>
      }
      // 시나리오 이름은 상단 선택 상자에 있다. 지금 화면과 다른 시나리오를 조사한 기록일 때만 붙인다
      meta={view && `${view.scenario && view.scenario !== scenario ? `${view.scenario} · ` : ''}${view.atSec === undefined ? '전체 기록' : `${formatElapsed(view.atSec)} 까지의 기록`}`}
      actions={
        <Button
          variant="primary"
          onClick={start}
          disabled={starting || !alerted}
          title={alerted ? `${formatElapsed(Math.floor(nowSec))} 까지의 기록으로 조사합니다. 화면 재생도 이 시점에서 멈춥니다` : '경보가 울리면 조사할 수 있습니다'}
        >
          {starting ? '시작하는 중…' : id ? '다시 조사' : '지금 시점까지 조사'}
        </Button>
      }
      className={`${s.card} area-inv`}
      bodyClassName={s.body}
    >
      {error && (
        <p className={s.error} role="alert">
          {error}
        </p>
      )}
      {!id ? (
        <EmptyState title={alerted ? '아직 조사하지 않았습니다' : '경보를 기다리는 중'}>
          {alerted ? '' : '경보가 울리면 조사할 수 있습니다. '}
          에이전트는 누른 시점까지의 경보·지표·로그·배포만 보고 원인과 조치를 제안합니다. 조치는 사람이 승인해야 실행됩니다
          {DEMO && '. 데모는 실제 모델로 T+02:00 시점에 돌린 조사를 재생하고, 승인·거절은 이 브라우저에만 반영됩니다'}
        </EmptyState>
      ) : !view ? (
        <EmptyState title={status === 'error' ? '조사 기록에 다시 연결하는 중' : '조사 기록을 불러오는 중'} />
      ) : (
        <InvestigationBody view={view} />
      )}
    </Card>
  );
}

function InvestigationBody({ view }: { view: InvestigationView }) {
  const prefix = useId();
  const [focused, setFocused] = useState<number>();
  const stepId = (n: number) => `${prefix}-step-${n}`;
  // 근거 번호를 누르면 그 도구 결과를 펼치고 그 자리로 옮긴다
  const openStep = (n: number) => {
    const li = document.getElementById(stepId(n));
    if (!li) return;
    li.querySelector('details')?.setAttribute('open', '');
    li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    li.querySelector<HTMLElement>('summary')?.focus({ preventScroll: true });
    setFocused(n);
  };

  return (
    <>
      {view.verdict && <VerdictBox verdict={view.verdict} onStep={openStep} stepHref={(n) => `#${stepId(n)}`} />}
      {view.proposal && <ProposalBox proposal={view.proposal} />}

      <section aria-labelledby={`${prefix}-h-steps`}>
        <h3 id={`${prefix}-h-steps`} className={s.subhead}>
          조사 과정 <span className={s.subheadMeta}>도구 {view.steps.length}회</span>
        </h3>
        <ol className={s.steps}>
          {view.steps.map((st, i) => (
            <li key={st.seq} id={stepId(i + 1)} className={s.step} data-focused={focused === i + 1 || undefined}>
              <span className={s.stepNo}>{i + 1}</span>
              <div className={s.stepMain}>
                <span className={s.stepTool}>{TOOL_LABEL[st.tool] ?? st.tool}</span>
                <details className={s.stepDetail}>
                  <summary>
                    <code>{formatCall(st)}</code>
                    <span className={s.stepPreview}>→ {previewResult(st.result)}</span>
                  </summary>
                  <pre>{formatResult(st.result)}</pre>
                </details>
              </div>
            </li>
          ))}
          {view.phase === 'running' && (
            <li className={s.step} aria-live="polite">
              <span className={s.stepNo} aria-hidden="true">
                <span className="spinner" />
              </span>
              <span className={s.stepWaiting}>다음 도구를 고르는 중</span>
            </li>
          )}
        </ol>
      </section>

      {view.phase === 'failed' && (
        <p className={s.error} role="alert">
          결론을 내지 못했습니다: {view.failure}
        </p>
      )}
    </>
  );
}

const KIND: Record<Verdict['kind'], { label: string; tone: Tone; help: string }> = {
  deploy: { label: '배포 원인', tone: 'deploy', help: '특정 배포가 원인이라 롤백하면 풀린다고 봤습니다' },
  degrade: { label: '배포 무관', tone: 'neutral', help: '배포와 상관없는 성능 저하라 롤백할 대상이 없습니다' },
};

function VerdictBox({ verdict, onStep, stepHref }: { verdict: Verdict; onStep: (n: number) => void; stepHref: (n: number) => string }) {
  const kind = KIND[verdict.kind];
  return (
    <section className={s.verdict} aria-labelledby="h-verdict">
      <h3 id="h-verdict">
        결론 <b className={s.verdictService}>{verdict.service}</b>
        <span title={kind.help}>
          <Badge tone={kind.tone}>{kind.label}</Badge>
          <VisuallyHidden>. {kind.help}</VisuallyHidden>
        </span>
      </h3>
      {verdict.summary && <p className={s.summary}>{verdict.summary}</p>}
      {verdict.evidence.length > 0 && (
        <dl className={s.facts}>
          <dt>근거</dt>
          {verdict.evidence.map((e, i) => (
            <dd key={i}>
              {e.step > 0 ? (
                <a
                  className={s.stepRef}
                  href={stepHref(e.step)}
                  onClick={(ev) => {
                    ev.preventDefault();
                    onStep(e.step);
                  }}
                  aria-label={`${e.step}번 도구 결과 보기`}
                >
                  {e.step}
                </a>
              ) : (
                <span className={s.stepRef} aria-hidden="true">·</span>
              )}
              <span>{e.fact}</span>
            </dd>
          ))}
          {verdict.ruledOut.length > 0 && <dt>버린 후보</dt>}
          {verdict.ruledOut.map((r) => (
            <dd key={r.service} className={s.ruled}>
              <b className={s.ruledService}>{r.service}</b> {r.why}
            </dd>
          ))}
        </dl>
      )}
    </section>
  );
}

function actionText(a: Action) {
  return a.type === 'rollback' ? `${a.service} 롤백${a.version ? ` (${a.version} 되돌리기)` : ''}` : `${a.service} 담당자 호출`;
}

const DECIDED: Record<string, { label: string; tone: Tone }> = {
  approved: { label: '승인됨', tone: 'ok' },
  executed: { label: '승인·실행됨', tone: 'ok' },
  rejected: { label: '거절됨', tone: 'error' },
};

function ProposalBox({ proposal }: { proposal: NonNullable<InvestigationView['proposal']> }) {
  const [operator, setOperator] = useState(() => localStorage.getItem(OPERATOR_KEY) ?? '');
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  const opId = useId();
  const reasonId = useId();
  const hintId = useId();

  if (proposal.status !== 'pending') {
    const d = DECIDED[proposal.status]!;
    return (
      <section className={s.proposal} aria-labelledby="h-proposal">
        <h3 id="h-proposal">
          제안: {actionText(proposal.action)} <Badge tone={d.tone}>{d.label}</Badge>
        </h3>
        <p className={s.decidedBy}>
          {proposal.decidedBy} 님이 결정{proposal.reason && <> · 사유: {proposal.reason}</>}
          {proposal.status === 'executed' && ' · 실제 조치는 데모라 실행 기록만 남깁니다'}
        </p>
      </section>
    );
  }

  const operatorOk = OPERATOR_RE.test(operator);
  const submit = async (decision: 'approved' | 'rejected') => {
    if (!operatorOk || (decision === 'rejected' && !reason.trim())) return;
    setSending(true);
    setError(undefined);
    localStorage.setItem(OPERATOR_KEY, operator);
    try {
      await decideProposal(proposal.id, operator, decision, decision === 'rejected' ? reason.trim() : undefined);
      // 결과는 스트림의 decision 이벤트로 돌아온다
    } catch (e) {
      setError(e instanceof ApiError && e.status === 409 ? '이미 다른 사람이 결정했습니다. 곧 화면에 반영됩니다' : (e as Error).message);
    } finally {
      setSending(false);
    }
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submit(rejecting ? 'rejected' : 'approved');
  };

  return (
    <form className={s.proposal} aria-labelledby="h-proposal" onSubmit={onSubmit}>
      <h3 id="h-proposal">
        제안: {actionText(proposal.action)} <Badge tone="warn">승인 대기</Badge>
      </h3>
      <div className={s.field}>
        <label htmlFor={opId}>결정하는 사람</label>
        <input
          id={opId}
          value={operator}
          onChange={(e) => setOperator(e.target.value)}
          placeholder="kim"
          autoComplete="username"
          aria-invalid={operator !== '' && !operatorOk}
          aria-describedby={hintId}
        />
        <span id={hintId} className={s.hint}>
          영문·숫자·._- 1~40자. 감사 로그에 이 이름으로 남습니다
        </span>
      </div>
      {rejecting && (
        <div className={s.field}>
          <label htmlFor={reasonId}>거절 사유 (필수)</label>
          <textarea id={reasonId} value={reason} onChange={(e) => setReason(e.target.value)} rows={2} autoFocus />
        </div>
      )}
      {error && (
        <p className={s.error} role="alert">
          {error}
        </p>
      )}
      <div className={s.buttons}>
        {rejecting ? (
          <>
            <Button type="submit" variant="danger" disabled={sending || !operatorOk || !reason.trim()}>
              거절 확정
            </Button>
            <Button variant="secondary" onClick={() => setRejecting(false)}>
              취소
            </Button>
          </>
        ) : (
          <>
            <Button type="submit" variant="primary" disabled={sending || !operatorOk}>
              승인: {actionText(proposal.action)}
            </Button>
            <Button variant="secondary" onClick={() => setRejecting(true)} disabled={sending}>
              거절
            </Button>
          </>
        )}
        {!operatorOk && <VisuallyHidden>결정하는 사람 이름을 넣어야 버튼이 켜집니다</VisuallyHidden>}
      </div>
    </form>
  );
}
