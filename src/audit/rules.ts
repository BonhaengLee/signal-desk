// 결정 입력 규칙. 서버(store.ts), 데모(src/web/demo.ts), 화면 입력 검사(src/web/Investigation.tsx)가 같이 쓴다.
// node:sqlite 를 가져오는 store.ts 는 화면 번들에 넣을 수 없어서 규칙만 따로 둔다.

export const OPERATOR_RE = /^[\w.-]{1,40}$/;

export const DECISION_ERRORS = {
  operator: 'operator 는 영문·숫자·._- 1~40자',
  reason: '거절에는 사유가 필요하다',
} as const;

/** 규칙을 어긴 입력이면 그 문구를, 맞으면 undefined */
export function decisionInputError(operator: string, decision: 'approved' | 'rejected', reason?: string): string | undefined {
  if (!OPERATOR_RE.test(operator)) return DECISION_ERRORS.operator;
  if (decision === 'rejected' && !reason?.trim()) return DECISION_ERRORS.reason;
  return undefined;
}
