import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuditStore, TransitionError } from '../src/audit/store.ts';

function store() {
  let t = Date.parse('2026-01-01T00:00:00Z');
  return new AuditStore(':memory:', () => new Date((t += 1000)));
}

test('감사 로그는 조사마다 seq 1부터 순서대로 쌓인다', () => {
  const s = store();
  const a = s.createInvestigation('silent-db', 1, 'm');
  const b = s.createInvestigation('retry-storm', 2, 'm');
  s.append(a, 'agent', 'tool_call', { tool: 'list_alerts' });
  s.append(b, 'agent', 'tool_call', { tool: 'list_deploys' });
  s.append(a, 'agent', 'verdict', { service: 'payment-db' });
  assert.deepEqual(s.events(a).map((e) => [e.seq, e.kind]), [[1, 'investigation_started'], [2, 'tool_call'], [3, 'verdict']]);
  assert.deepEqual(s.events(b).map((e) => e.seq), [1, 2]);
  assert.deepEqual(s.events(a, 2).map((e) => e.seq), [3]);
});

test('감사 로그는 DB 에서 직접 고치거나 지울 수 없다', () => {
  const s = store();
  s.createInvestigation('silent-db', 1, 'm');
  assert.throws(() => s.db.exec("UPDATE audit_events SET actor = 'agent'"), /수정할 수 없다/);
  assert.throws(() => s.db.exec('DELETE FROM audit_events'), /지울 수 없다/);
  assert.equal((s.db.prepare('SELECT COUNT(*) n FROM audit_events').get() as { n: number }).n, 1);
});

test('승인 → 실행 순서로만 진행되고 모든 단계가 기록된다', () => {
  const s = store();
  const inv = s.createInvestigation('hidden-deploy', 1, 'm');
  const p = s.propose(inv, { type: 'rollback', service: 'payment-api', version: 'v1.4.2' });
  assert.throws(() => s.markExecuted(p.id), (e) => e instanceof TransitionError && /pending 상태에서는 executed/.test(e.message));
  const approved = s.decide(p.id, 'kim', 'approved');
  assert.deepEqual([approved.status, approved.decidedBy], ['approved', 'operator:kim']);
  const done = s.markExecuted(p.id);
  assert.deepEqual([done.status, done.decidedBy], ['executed', 'operator:kim']);
  assert.deepEqual(
    s.events(inv).map((e) => [e.actor, e.kind]),
    [['system', 'investigation_started'], ['agent', 'proposal'], ['operator:kim', 'decision'], ['system', 'execution']],
  );
});

test('이미 결정된 제안은 다시 결정할 수 없다 (먼저 누른 한 명만 성공)', () => {
  const s = store();
  const inv = s.createInvestigation('silent-db', 1, 'm');
  const p = s.propose(inv, { type: 'escalate', service: 'payment-db' });
  s.decide(p.id, 'kim', 'approved');
  assert.throws(() => s.decide(p.id, 'lee', 'rejected', '원인 아님'), /approved 상태에서는 rejected/);
  assert.equal(s.proposal(p.id)!.decidedBy, 'operator:kim');
  assert.equal(s.events(inv).filter((e) => e.kind === 'decision').length, 1);
});

test('거절은 사유가 있어야 하고, 실행할 수 없다', () => {
  const s = store();
  const inv = s.createInvestigation('silent-db', 1, 'm');
  const p = s.propose(inv, { type: 'rollback', service: 'checkout-api' });
  assert.throws(() => s.decide(p.id, 'kim', 'rejected', '  '), /사유가 필요/);
  assert.equal(s.proposal(p.id)!.status, 'pending');
  s.decide(p.id, 'kim', 'rejected', 'checkout 배포는 경보 5초 전, DB 지연이 먼저');
  assert.throws(() => s.markExecuted(p.id), /rejected 상태에서는 executed/);
  assert.equal(s.proposal(p.id)!.reason, 'checkout 배포는 경보 5초 전, DB 지연이 먼저');
});

test('실패한 전이는 감사 로그를 남기지 않는다 (트랜잭션 롤백)', () => {
  const s = store();
  const inv = s.createInvestigation('silent-db', 1, 'm');
  const p = s.propose(inv, { type: 'escalate', service: 'payment-db' });
  const before = s.events(inv).length;
  assert.throws(() => s.markExecuted(p.id));
  assert.throws(() => s.decide(p.id, 'bad name!', 'approved'), /operator/);
  assert.equal(s.events(inv).length, before);
});

test('같은 DB 파일을 연 두 연결이 모두 pending 을 본 뒤 차례로 결정하면 뒤 결정은 거부된다', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'sd-audit-'));
  try {
    const file = join(dir, 'audit.db');
    const s1 = new AuditStore(file);
    const s2 = new AuditStore(file);
    const inv = s1.createInvestigation('silent-db', 1, 'm');
    const p = s1.propose(inv, { type: 'escalate', service: 'payment-db' });
    // 둘 다 pending 을 본 상태에서 결정한다
    assert.deepEqual([s1.proposal(p.id)!.status, s2.proposal(p.id)!.status], ['pending', 'pending']);
    s1.decide(p.id, 'kim', 'approved');
    assert.throws(() => s2.decide(p.id, 'lee', 'rejected', '다른 판단'), /approved 상태에서는 rejected/);
    assert.equal(s2.events(inv).filter((e) => e.kind === 'decision').length, 1);
    s1.db.close();
    s2.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('결정 기록 쓰기가 실패하면 제안 상태도 바뀌지 않는다', () => {
  const s = store();
  const inv = s.createInvestigation('silent-db', 1, 'm');
  const p = s.propose(inv, { type: 'escalate', service: 'payment-db' });
  // 디스크 오류 등으로 감사 로그 쓰기가 실패하는 상황을 트리거로 흉내 낸다
  s.db.exec("CREATE TRIGGER fail_decision BEFORE INSERT ON audit_events WHEN NEW.kind = 'decision' BEGIN SELECT RAISE(ABORT, '쓰기 실패'); END;");
  assert.throws(() => s.decide(p.id, 'kim', 'approved'), /쓰기 실패/);
  assert.equal(s.proposal(p.id)!.status, 'pending');
});

test('앱 코드를 거치지 않은 SQL 로도 제안 상태를 건너뛰거나 결정을 고치거나 지울 수 없다', () => {
  const s = store();
  const inv = s.createInvestigation('silent-db', 1, 'm');
  const p = s.propose(inv, { type: 'escalate', service: 'payment-db' });
  const blocked = /pending→approved\|rejected, approved→executed 로만/;
  assert.throws(() => s.db.prepare("UPDATE proposals SET status = 'executed', decided_by = 'x' WHERE id = ?").run(p.id), blocked);
  assert.throws(() => s.db.prepare("UPDATE proposals SET action = '{}' WHERE id = ?").run(p.id), blocked);
  s.decide(p.id, 'kim', 'approved');
  assert.throws(() => s.db.prepare("UPDATE proposals SET decided_by = 'operator:lee' WHERE id = ?").run(p.id), blocked);
  assert.throws(() => s.db.prepare("UPDATE proposals SET status = 'rejected', reason = '바꿈' WHERE id = ?").run(p.id), blocked);
  assert.throws(() => s.db.prepare('DELETE FROM proposals WHERE id = ?').run(p.id), /지울 수 없다/);
  // 허용된 전이는 그대로 된다
  assert.deepEqual([s.markExecuted(p.id).status, s.proposal(p.id)!.decidedBy], ['executed', 'operator:kim']);
});

test('승인 후 실행 기록이 실패하면 승인도 되돌려 approved 에 멈춘 제안이 남지 않는다', () => {
  const s = store();
  const inv = s.createInvestigation('silent-db', 1, 'm');
  const p = s.propose(inv, { type: 'escalate', service: 'payment-db' });
  const before = s.events(inv).length;
  s.db.exec("CREATE TRIGGER fail_execution BEFORE INSERT ON audit_events WHEN NEW.kind = 'execution' BEGIN SELECT RAISE(ABORT, '실행 기록 실패'); END;");
  assert.throws(() => s.decideAndExecute(p.id, 'kim', 'approved'), /실행 기록 실패/);
  assert.deepEqual([s.proposal(p.id)!.status, s.events(inv).length], ['pending', before]);
  s.db.exec('DROP TRIGGER fail_execution');
  assert.equal(s.decideAndExecute(p.id, 'kim', 'approved').status, 'executed');
  assert.deepEqual(s.events(inv).slice(-2).map((e) => e.kind), ['decision', 'execution']);
});

test('전이 오류는 종류로 나뉜다 (이미 결정 409 · 입력 오류 400 · 없는 제안 404)', () => {
  const s = store();
  const inv = s.createInvestigation('silent-db', 1, 'm');
  const p = s.propose(inv, { type: 'escalate', service: 'payment-db' });
  const reasonOf = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      return e instanceof TransitionError ? e.reason : 'other';
    }
    return 'none';
  };
  assert.deepEqual(
    [
      reasonOf(() => s.decide(p.id, 'bad name!', 'approved')),
      reasonOf(() => s.decide(p.id, 'kim', 'rejected', '  ')),
      reasonOf(() => s.decide('00000000-0000-0000-0000-000000000000', 'kim', 'approved')),
      reasonOf(() => (s.decide(p.id, 'kim', 'approved'), s.decide(p.id, 'lee', 'approved'))),
    ],
    ['invalid', 'invalid', 'not_found', 'conflict'],
  );
});

test('다른 연결이 쓰는 중이면 바로 실패하지 않고 기다린다 (busy_timeout)', () => {
  assert.equal((store().db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout, 5000);
});
