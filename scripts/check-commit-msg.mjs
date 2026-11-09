#!/usr/bin/env node
// 커밋 메시지 검사: 무엇·왜·대안 세 줄이 있는지, 기계가 쓴 티가 나는 틀을 쓰지 않았는지 본다.
// 사용법: node scripts/check-commit-msg.mjs <메시지 파일>   (git commit-msg 훅에서 부른다)
// 통과 0, 위반 1, 사용법 오류 2

import { readFileSync } from 'node:fs';

/** [이름, 정규식, 고치는 법] */
export const RULES = [
  ['대시 기호', /[—–]/, '대시로 이름표를 붙이지 말고 문장을 둘로 나눈다. 예) "EventSource 를 쓰면 …. 하지만 … 쓰지 않았다."'],
  ['양보 나열 틀', /지만[^.\n]{0,60}(없고|않고|못하고)[^.\n]{0,40}(없다|않는다|못한다)/, '"~지만 ~없고 ~못한다"를 한 문장에 몰지 말고, 장점 한 문장과 안 쓴 이유 한 문장으로 나눈다'],
  ['번역투', /(에 대한|을 통해|를 통해|라고 할 수 있다|하는 것이 가능하다|를 진행)/, '"A에 대한 B" → "A의 B", "~을 통해" → "~로", "~하는 것이 가능하다" → "~할 수 있다"'],
  ['상투어', /(획기적|혁신적|다양한|효율적으로|원활하게|최적화된)/, '구체적인 수치나 관찰로 바꾼다'],
];

const LABELS = ['무엇:', '왜:', '대안:'];

/** 메시지 본문을 검사해 위반 목록을 돌려준다. 주석(#) 줄은 git 이 지우므로 무시한다 */
export function checkCommitMessage(text) {
  const body = text
    .split('\n')
    .filter((l) => !l.startsWith('#'))
    .join('\n');
  const problems = [];
  // 병합·되돌리기 커밋은 git 이 만든 문장이라 검사하지 않는다
  if (/^(Merge|Revert) /.test(body)) return problems;
  for (const label of LABELS) {
    if (!body.split('\n').some((l) => l.startsWith(label))) problems.push(`"${label}" 줄이 없다 (무엇·왜·대안 세 줄 필요)`);
  }
  for (const [name, re, fix] of RULES) {
    const line = body.split('\n').find((l) => re.test(l));
    if (line) problems.push(`${name}: "${line.trim().slice(0, 60)}" → ${fix}`);
  }
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (!file) {
    console.error('사용법: node scripts/check-commit-msg.mjs <메시지 파일>');
    process.exit(2);
  }
  const problems = checkCommitMessage(readFileSync(file, 'utf8'));
  if (problems.length > 0) {
    console.error('[commit-msg] 커밋 메시지를 고쳐 주세요:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
}
