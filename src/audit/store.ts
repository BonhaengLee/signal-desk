// 조사·조치 기록 저장소 (SQLite, Node 내장 node:sqlite).
// - audit_events 는 추가만 된다. 수정·삭제는 트리거가 DB 수준에서 거부한다
// - proposals 의 상태는 pending → approved → executed 또는 pending → rejected 로만 바뀐다.
//   "지금 상태가 X 일 때만 바꾼다"를 UPDATE ... WHERE status = X 한 문장으로 해서, 두 사람이 동시에 눌러도 한 명만 성공한다.
//   이 규칙은 트리거로 DB 에도 걸어 둔다. 앱 코드를 거치지 않은 UPDATE·DELETE 도 막힌다

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { decisionInputError } from './rules.ts';

export type Actor = 'agent' | 'system' | `operator:${string}`;
export type AuditKind = 'investigation_started' | 'tool_call' | 'verdict' | 'proposal' | 'decision' | 'execution' | 'investigation_failed';
export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'executed';

export interface Action {
  type: 'rollback' | 'escalate';
  service: string;
  version?: string; // rollback 대상 배포
}

export interface AuditEvent {
  seq: number;
  at: string;
  actor: Actor;
  kind: AuditKind;
  payload: unknown;
}

export interface Proposal {
  id: string;
  investigationId: string;
  action: Action;
  status: ProposalStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  reason: string | null;
}

/** 상태 전이 실패. conflict(이미 결정됨 → 409)와 invalid(입력 오류 → 400)를 나눈다 */
export class TransitionError extends Error {
  readonly reason: 'conflict' | 'invalid' | 'not_found';
  constructor(reason: 'conflict' | 'invalid' | 'not_found', message: string) {
    super(message);
    this.reason = reason;
  }
}

const SCHEMA = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
-- 다른 연결이 쓰는 중이면 바로 SQLITE_BUSY 를 내지 않고 기다린다
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS investigations (
  id          TEXT PRIMARY KEY,
  scenario    TEXT NOT NULL,
  seed        INTEGER NOT NULL,
  model       TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  investigation_id TEXT NOT NULL REFERENCES investigations(id),
  seq              INTEGER NOT NULL,
  at               TEXT NOT NULL,
  actor            TEXT NOT NULL CHECK (actor IN ('agent', 'system') OR actor LIKE 'operator:_%'),
  kind             TEXT NOT NULL,
  payload          TEXT NOT NULL CHECK (json_valid(payload)),
  UNIQUE (investigation_id, seq)
);

CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events 는 수정할 수 없다'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events 는 지울 수 없다'); END;

CREATE TABLE IF NOT EXISTS proposals (
  id               TEXT PRIMARY KEY,
  investigation_id TEXT NOT NULL REFERENCES investigations(id),
  action           TEXT NOT NULL CHECK (json_valid(action)),
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'executed')),
  decided_by       TEXT,
  decided_at       TEXT,
  reason           TEXT,
  created_at       TEXT NOT NULL,
  CHECK (status = 'pending' OR decided_by IS NOT NULL),
  CHECK (status <> 'rejected' OR length(trim(reason)) > 0)
);
CREATE INDEX IF NOT EXISTS proposals_by_investigation ON proposals (investigation_id, status);

-- 허용된 전이만 통과시킨다. 결정 뒤에는 결정자·시각·사유도 바꿀 수 없다
CREATE TRIGGER IF NOT EXISTS proposals_transition BEFORE UPDATE ON proposals
WHEN NOT (
  NEW.id = OLD.id AND NEW.investigation_id = OLD.investigation_id AND NEW.action = OLD.action AND NEW.created_at = OLD.created_at
  AND (
    (OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected'))
    OR (OLD.status = 'approved' AND NEW.status = 'executed'
        AND NEW.decided_by IS OLD.decided_by AND NEW.decided_at IS OLD.decided_at AND NEW.reason IS OLD.reason)
  )
)
BEGIN SELECT RAISE(ABORT, 'proposals 는 pending→approved|rejected, approved→executed 로만 바뀐다'); END;
CREATE TRIGGER IF NOT EXISTS proposals_no_delete BEFORE DELETE ON proposals
BEGIN SELECT RAISE(ABORT, 'proposals 는 지울 수 없다'); END;
`;

export class AuditStore {
  readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(path = ':memory:', now: () => Date = () => new Date()) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
    this.now = now;
  }

  createInvestigation(scenario: string, seed: number, model: string, atSec?: number): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO investigations (id, scenario, seed, model, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, scenario, seed, model, this.now().toISOString());
    this.append(id, 'system', 'investigation_started', { scenario, seed, model, ...(atSec === undefined ? {} : { atSec }) });
    return id;
  }

  /** 조사마다 seq 를 1부터 붙인다. UNIQUE(investigation_id, seq) 가 순서 꼬임을 막는다 */
  append(investigationId: string, actor: Actor, kind: AuditKind, payload: unknown): AuditEvent {
    const at = this.now().toISOString();
    const row = this.db
      .prepare(`INSERT INTO audit_events (investigation_id, seq, at, actor, kind, payload)
        VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM audit_events WHERE investigation_id = ?), ?, ?, ?, ?)
        RETURNING seq`)
      .get(investigationId, investigationId, at, actor, kind, JSON.stringify(payload)) as { seq: number };
    return { seq: row.seq, at, actor, kind, payload };
  }

  events(investigationId: string, afterSeq = 0): AuditEvent[] {
    const rows = this.db
      .prepare('SELECT seq, at, actor, kind, payload FROM audit_events WHERE investigation_id = ? AND seq > ? ORDER BY seq')
      .all(investigationId, afterSeq) as { seq: number; at: string; actor: Actor; kind: AuditKind; payload: string }[];
    return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
  }

  propose(investigationId: string, action: Action): Proposal {
    const id = randomUUID();
    this.transaction(() => {
      this.db.prepare('INSERT INTO proposals (id, investigation_id, action, created_at) VALUES (?, ?, ?, ?)')
        .run(id, investigationId, JSON.stringify(action), this.now().toISOString());
      this.append(investigationId, 'agent', 'proposal', { proposalId: id, action });
    });
    return this.proposal(id)!;
  }

  proposal(id: string): Proposal | undefined {
    const r = this.db.prepare('SELECT * FROM proposals WHERE id = ?').get(id) as Record<string, string> | undefined;
    if (!r) return undefined;
    return {
      id: r.id!,
      investigationId: r.investigation_id!,
      action: JSON.parse(r.action!),
      status: r.status as ProposalStatus,
      decidedBy: r.decided_by ?? null,
      decidedAt: r.decided_at ?? null,
      reason: r.reason ?? null,
    };
  }

  /** 승인·거절. pending 일 때만 바뀐다. 거절은 사유가 있어야 한다 */
  decide(id: string, operator: string, decision: 'approved' | 'rejected', reason?: string): Proposal {
    const actor = decisionActor(operator, decision, reason);
    return this.transaction(() => this.transition(id, 'pending', decision, actor, reason ?? null, 'decision'));
  }

  /** 실행 기록. approved 일 때만 된다. 실제 조치는 시뮬레이션이라 기록만 남긴다 */
  markExecuted(id: string): Proposal {
    return this.transaction(() => this.transition(id, 'approved', 'executed', 'system', null, 'execution'));
  }

  /** 결정하고, 승인이면 실행 기록까지 한 트랜잭션으로 남긴다. 실행 기록이 실패하면 승인도 되돌려 approved 에 멈춘 제안이 생기지 않는다 */
  decideAndExecute(id: string, operator: string, decision: 'approved' | 'rejected', reason?: string): Proposal {
    const actor = decisionActor(operator, decision, reason);
    return this.transaction(() => {
      const p = this.transition(id, 'pending', decision, actor, reason ?? null, 'decision');
      return p.status === 'approved' ? this.transition(id, 'approved', 'executed', 'system', null, 'execution') : p;
    });
  }

  /** 트랜잭션 안에서만 부른다 */
  private transition(id: string, from: ProposalStatus, to: ProposalStatus, actor: Actor, reason: string | null, kind: AuditKind): Proposal {
    const at = this.now().toISOString();
    const decidedBy = to === 'executed' ? null : actor; // 실행은 결정자를 덮어쓰지 않는다
    const res = this.db
      .prepare(`UPDATE proposals SET status = ?, decided_by = COALESCE(?, decided_by), decided_at = COALESCE(?, decided_at), reason = COALESCE(?, reason)
        WHERE id = ? AND status = ?`)
      .run(to, decidedBy, to === 'executed' ? null : at, reason, id, from);
    if (res.changes !== 1) {
      const current = this.proposal(id);
      if (!current) throw new TransitionError('not_found', `없는 제안: ${id}`);
      throw new TransitionError('conflict', `${current.status} 상태에서는 ${to} 로 바꿀 수 없다`);
    }
    const p = this.proposal(id)!;
    this.append(p.investigationId, actor, kind, { proposalId: id, from, to, ...(reason ? { reason } : {}) });
    return p;
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
}

/** 결정 입력 검사. 규칙은 rules.ts 하나에 있고 데모도 같은 것을 쓴다 */
function decisionActor(operator: string, decision: 'approved' | 'rejected', reason?: string): Actor {
  const error = decisionInputError(operator, decision, reason);
  if (error) throw new TransitionError('invalid', error);
  return `operator:${operator}`;
}
