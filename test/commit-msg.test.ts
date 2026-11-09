import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error 타입 선언 없는 .mjs 스크립트
import { checkCommitMessage } from '../scripts/check-commit-msg.mjs';

const ok = `feat: SSE 재연결

무엇: 끊기면 다시 붙는다
왜: 화면이 68건에서 멈췄다
대안: EventSource 를 쓰면 재연결 코드가 필요 없다. 하지만 재시도 간격을 바꿀 수 없어서 쓰지 않았다
`;

test('세 줄이 있고 틀에 걸리지 않으면 통과', () => {
  assert.deepEqual(checkCommitMessage(ok), []);
});

test('실제로 쓰였던 어색한 문장을 잡는다', () => {
  const bad = ok.replace(
    /대안:.*\n/,
    '대안: 브라우저 내장 EventSource — 재연결을 자동으로 해 주지만 백오프를 조절할 수 없고, 조용히 멈춘 연결을 감지하지 못한다\n',
  );
  const names = checkCommitMessage(bad).map((p: string) => p.split(':')[0]);
  assert.deepEqual(names, ['대시 기호', '양보 나열 틀']);
});

test('무엇·왜·대안 줄이 빠지면 막는다', () => {
  assert.deepEqual(checkCommitMessage('fix: 오타\n\n무엇: 오타 수정\n'), [
    '"왜:" 줄이 없다 (무엇·왜·대안 세 줄 필요)',
    '"대안:" 줄이 없다 (무엇·왜·대안 세 줄 필요)',
  ]);
});

test('번역투와 상투어를 잡는다', () => {
  const names = checkCommitMessage(ok.replace('화면이 68건에서 멈췄다', '연결에 대한 처리를 효율적으로 개선')).map((p: string) => p.split(':')[0]);
  assert.deepEqual(names, ['번역투', '상투어']);
});

test('git 주석 줄과 병합 커밋은 검사하지 않는다', () => {
  assert.deepEqual(checkCommitMessage(ok + '# 대시 — 는 주석이라 무시\n'), []);
  assert.deepEqual(checkCommitMessage("Merge branch 'ui-design'\n"), []);
});
