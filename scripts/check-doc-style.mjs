#!/usr/bin/env node
// 문서 끝맺음 검사: 한 문서 안에서 "~합니다"(합쇼체)와 "~한다"(해라체)가 섞이지 않게 한다.
// README 는 합쇼체, docs/ 의 ADR 은 해라체. 코드 블록·인라인 코드·명사로 끝나는 표 칸은 보지 않는다.
// 사용법: node scripts/check-doc-style.mjs [파일...]   (인자가 없으면 저장소 기본 대상)
// 통과 0, 위반 1

import { readFileSync, readdirSync } from 'node:fs';

/** 파일 경로 → 요구하는 끝맺음 */
export function styleFor(path) {
  if (/(^|\/)README\.md$/.test(path)) return 'formal';
  if (/(^|\/)docs\/.*\.md$/.test(path)) return 'plain';
  return undefined;
}

// 합쇼체: 앞 글자에 ㅂ 받침이 붙은 ~니다·~니까(합니다, 됩니다, 갑니까), ~습니다, ~세요
// "아니다" 는 해라체다. 그래서 "니다" 앞 글자의 받침을 본다
const JONG_B = 17; // 한글 음절의 종성 인덱스: ㅂ
const hasB = (ch) => {
  const c = ch.codePointAt(0) - 0xac00;
  return c >= 0 && c < 11172 && c % 28 === JONG_B;
};
export function endingOf(end) {
  if (/세요$/.test(end)) return 'formal';
  const m = /(.)(니다|니까)$/.exec(end);
  if (m && (m[1] === '습' || hasB(m[1]))) return 'formal';
  if (/다$/.test(end)) return 'plain';
  return undefined; // 명사·기호로 끝나면 판단하지 않는다
}

/** 문서에서 "문장 끝"마다 [줄 번호, 끝 조각] 을 뽑는다 */
export function sentenceEnds(text) {
  const out = [];
  let inFence = false;
  text.split('\n').forEach((raw, i) => {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const line = raw
      .replace(/`[^`]*`/g, ' ') // 인라인 코드
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 링크는 글자만
      .replace(/[*_]/g, '');
    // 표는 칸마다, 나머지는 줄 전체를 문장 덩어리로 본다
    const chunks = /^\s*\|/.test(line) ? line.split('|') : [line];
    for (const chunk of chunks) {
      for (const part of chunk.split(/(?<=[.!?])\s+|\.$/)) {
        const end = part.trim().replace(/[.!?:)"'」]+$/, '').trim();
        if (end) out.push([i + 1, end]);
      }
    }
  });
  return out;
}

/** 요구 끝맺음과 다른 문장을 [줄 번호, 문장 끝 20자] 로 돌려준다 */
export function checkDocStyle(text, style) {
  const wrong = style === 'formal' ? 'plain' : 'formal';
  return sentenceEnds(text)
    .filter(([, end]) => endingOf(end) === wrong)
    .map(([line, end]) => [line, end.slice(-20)]);
}

export function defaultTargets() {
  const adr = readdirSync('docs/adr').filter((f) => f.endsWith('.md')).map((f) => `docs/adr/${f}`);
  return ['README.md', ...adr];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = process.argv.length > 2 ? process.argv.slice(2) : defaultTargets();
  let bad = 0;
  for (const f of files) {
    const style = styleFor(f);
    if (!style) continue;
    for (const [line, end] of checkDocStyle(readFileSync(f, 'utf8'), style)) {
      console.error(`${f}:${line} ${style === 'formal' ? '"~합니다"로' : '"~한다"로'} 맞출 것: …${end}`);
      bad += 1;
    }
  }
  if (bad > 0) {
    console.error(`[doc-style] 끝맺음 섞임 ${bad}건`);
    process.exit(1);
  }
}
