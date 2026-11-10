import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AuditEvent } from '../src/audit/store.ts';
import { demoDecide, playbackGaps, STEP_MAX_MS, STEP_MIN_MS } from '../src/web/demo.ts';
import { demoEvents } from '../scripts/build-demo.ts';
import { readFileSync } from 'node:fs';

const at = (s: number): AuditEvent => ({ seq: s, at: new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString(), actor: 'agent', kind: 'tool_call', payload: {} });

test('녹화 재생 간격: 실제 간격을 0.5~1.5초 안으로 줄인다', () => {
  // 0초, 0.2초 뒤(→0.5), 1초 뒤, 30초 뒤(→1.5)
  const ev = [at(0), { ...at(0), at: '2026-01-01T00:00:00.200Z' }, at(1), at(31)];
  assert.deepEqual(playbackGaps(ev), [0, STEP_MIN_MS, 800, STEP_MAX_MS]);
});

test('데모 결정도 서버와 같은 규칙: 이름 형식, 거절 사유 필수, 모르는 제안은 404', () => {
  const err = (f: () => void) => {
    try {
      f();
      return 'ok';
    } catch (e) {
      return `${(e as { status: number }).status} ${(e as Error).message}`;
    }
  };
  assert.deepEqual(
    [err(() => demoDecide('p', '김', 'approved')), err(() => demoDecide('p', 'kim', 'rejected', ' ')), err(() => demoDecide('p', 'kim', 'approved'))],
    ['400 operator 는 영문·숫자·._- 1~40자', '400 거절에는 사유가 필요하다', '404 없는 제안'],
  );
});

test('데모 이벤트 파일에는 시나리오 정답과 설명이 들어가지 않는다', () => {
  const s = JSON.parse(readFileSync('scenarios/db-degradation.json', 'utf8'));
  const out = JSON.stringify(demoEvents(s));
  assert.deepEqual([out.includes('rootCause'), out.includes('description'), out.includes(s.description)], [false, false, false]);
});
