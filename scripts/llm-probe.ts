// 후보 모델별 도구 호출 성공 여부와 응답 시간 측정. 에이전트 모델 선택 근거용
// 사용법: node --env-file=.env.local scripts/llm-probe.ts [반복 수] [모델...]

const BASE = process.env.LLM_BASE_URL;
const KEY = process.env.LLM_API_KEY;
if (!BASE || !KEY) throw new Error('LLM_BASE_URL, LLM_API_KEY 필요 (.env.local)');

const DEFAULT_MODELS = [
  'gemini-3.8-flash', 'gemini-3.5-flash', 'gpt-oss-120b', 'qwen3.8-flash', 'deepseek-v4-flash',
  'glm-5.3-flash', 'llama-3.3-70b', 'gpt-5.4-mini', 'claude-haiku-4-5', 'mistral-small-4',
];
const runs = Number(process.argv[2] ?? 3);
const models = process.argv.length > 3 ? process.argv.slice(3) : DEFAULT_MODELS;

const tools = [{
  type: 'function',
  function: {
    name: 'get_deploys',
    description: '서비스의 최근 배포 이력을 조회한다',
    parameters: { type: 'object', properties: { service: { type: 'string' } }, required: ['service'] },
  },
}];
const messages = [
  { role: 'system', content: '장애 조사 에이전트. 필요하면 도구를 호출한다.' },
  { role: 'user', content: 'checkout-api p99 가 급증했다. 먼저 checkout-api 의 배포 이력을 확인해.' },
];

interface Result { model: string; ok: number; ms: number[]; err?: string }

async function probe(model: string): Promise<Result> {
  const r: Result = { model, ok: 0, ms: [] };
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    try {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, tools, temperature: 0 }),
        signal: AbortSignal.timeout(60_000),
      });
      const body = await res.json();
      const ms = Math.round(performance.now() - t0);
      if (!res.ok) { r.err = `HTTP ${res.status}`; continue; }
      const call = body.choices?.[0]?.message?.tool_calls?.[0];
      const args = call ? JSON.parse(call.function.arguments || '{}') : undefined;
      r.ms.push(ms);
      if (call?.function?.name === 'get_deploys' && args?.service === 'checkout-api') r.ok += 1;
      else r.err = '도구 호출 없음/인자 틀림';
    } catch (e) {
      r.err = (e as Error).name === 'TimeoutError' ? '60s 초과' : (e as Error).message.slice(0, 40);
    }
  }
  return r;
}

const median = (xs: number[]) => xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : NaN;

const results = await Promise.all(models.map(probe));
results.sort((a, b) => b.ok - a.ok || median(a.ms) - median(b.ms));
console.log(`| 모델 | 도구 호출 성공 | 응답 중앙값(ms) | 비고 |\n|---|---|---|---|`);
for (const r of results) console.log(`| ${r.model} | ${r.ok}/${runs} | ${median(r.ms) || '-'} | ${r.err ?? ''} |`);
