import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// @ts-expect-error 타입 선언 없는 .mjs 스크립트
import { checkDocStyle, defaultTargets, endingOf, styleFor } from '../scripts/check-doc-style.mjs';

test('끝맺음 판별: "아니다"는 해라체, "합니다·됩니다·돌립니다"는 합쇼체, 명사로 끝나면 판단 안 함', () => {
  assert.deepEqual(
    ['잰 것은 아니다', '실행합니다', '바뀝니다', '돌립니다', '있습니까', '확인하세요', '멈춘다', '재연결', '15/25'].map(endingOf),
    ['plain', 'formal', 'formal', 'formal', 'formal', 'formal', 'plain', undefined, undefined],
  );
});

test('README 에 "~한다"가 섞이면 줄 번호와 함께 잡는다. 코드 블록·인라인 코드는 보지 않는다', () => {
  const md = [
    '# 제목',
    '화면을 보여 줍니다.',
    '| 경로 | 내용 |',
    '| `a` | 모델로 돌린다. 결과가 같습니다 |',
    '```sh',
    'echo "이건 코드라서 본다"',
    '```',
    '`x 를 쓴다` 는 인라인 코드입니다.',
  ].join('\n');
  assert.deepEqual(checkDocStyle(md, 'formal'), [[4, '모델로 돌린다']]);
});

test('ADR 에 "~합니다"가 섞이면 잡는다', () => {
  assert.deepEqual(checkDocStyle('고른 이유를 적는다.\n되돌리는 비용은 작습니다.', 'plain'), [[2, '되돌리는 비용은 작습니다']]);
});

test('저장소의 README 와 ADR 은 문서마다 끝맺음이 하나로 맞춰져 있다', () => {
  const files: string[] = defaultTargets();
  assert.equal(files[0], 'README.md');
  const problems = files.flatMap((f) => checkDocStyle(readFileSync(f, 'utf8'), styleFor(f)).map(([l, e]: [number, string]) => `${f}:${l} …${e}`));
  assert.deepEqual(problems, []);
});
