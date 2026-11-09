import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dependencyOrder, simulate, type Scenario } from '../src/simulator/simulate.ts';
import { parseEvent, type SignalEvent } from '../src/events/schema.ts';

const NAMES = ['deploy-regression', 'db-degradation', 'retry-storm'] as const;
const load = (name: string): Scenario =>
  JSON.parse(readFileSync(new URL(`../scenarios/${name}.json`, import.meta.url), 'utf8')) as Scenario;
const run = (sc: Scenario, seed = 42): SignalEvent[] => [...simulate(sc, seed)];
const sec = (sc: Scenario, e: SignalEvent) => (e.at.getTime() - Date.parse(sc.startAt)) / 1000;
const p99Series = (events: SignalEvent[], service: string) =>
  events.flatMap((e) => (e.type === 'metric' && e.service === service && e.payload.name === 'latency_p99' ? [e.payload.value] : []));

for (const name of NAMES) {
  test(`${name}: 같은 시드는 같은 이벤트열, 다른 시드는 다른 지표 값`, () => {
    const sc = load(name);
    assert.deepEqual(run(sc, 42), run(sc, 42));
    const values = (seed: number) => run(sc, seed).flatMap((e) => (e.type === 'metric' ? [e.payload.value] : []));
    assert.notDeepEqual(values(42), values(7));
  });

  test(`${name}: 모든 이벤트가 JSON 을 거친 뒤에도 스키마를 통과하고 원래 값으로 돌아온다`, () => {
    for (const e of run(load(name))) {
      assert.deepEqual(parseEvent(JSON.parse(JSON.stringify(e))), { ok: true, event: e }, `seq ${e.seq}`);
    }
  });

  test(`${name}: seq 는 0 부터 빠짐없이 1씩 늘고 id 는 겹치지 않는다`, () => {
    const events = run(load(name));
    assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i));
    assert.equal(new Set(events.map((e) => e.id)).size, events.length);
  });

  test(`${name}: 원인 주입 전에는 경보가 없다`, () => {
    const sc = load(name);
    const early = run(sc).filter((e) => e.type === 'alert' && sec(sc, e) < sc.rootCause.atSec);
    assert.deepEqual(early, []);
  });
}

test('deploy-regression: 배포 직후 원인 서비스 경보가 호출자 경보보다 먼저 나온다', () => {
  const sc = load('deploy-regression');
  const alerts = run(sc).filter((e) => e.type === 'alert');
  assert.deepEqual(
    alerts.slice(0, 2).map((e) => [e.service, sec(sc, e), e.payload.state]),
    [
      ['payment-api', 60, 'firing'],
      ['checkout-api', 60, 'firing'],
    ],
  );
});

test('db-degradation: "첫 경보 직전 배포가 원인"이라는 추측은 무관한 서비스를 고른다', () => {
  const sc = load('db-degradation');
  const events = run(sc);
  const firstAlert = events.find((e) => e.type === 'alert')!;
  const lastDeployBefore = events.filter((e) => e.type === 'deploy' && e.seq < firstAlert.seq).at(-1)!;
  assert.deepEqual([firstAlert.service, sec(sc, firstAlert)], ['payment-db', 70]);
  assert.equal(lastDeployBefore.service, 'checkout-api');
  assert.notEqual(lastDeployBefore.service, sc.rootCause.service);
  // 원인 서비스에는 배포 이벤트가 없다 (조용한 저하)
  assert.deepEqual(events.filter((e) => e.type === 'deploy' && e.service === 'payment-db'), []);
});

test('retry-storm: 저하가 끝난 뒤에도 재시도 때문에 회복하지 못하고, 재시도를 끄면 회복한다', () => {
  const sc = load('retry-storm');
  const threshold = sc.services.find((s) => s.name === 'payment-db')!.alertP99Ms!;
  const tail = (events: SignalEvent[]) => p99Series(events, 'payment-db').slice(-6);

  const withRetry = tail(run(sc));
  assert.deepEqual(withRetry.filter((v) => v <= threshold), [], `재시도 있음: ${withRetry}`);
  assert.equal(withRetry.length, 6);

  const noRetry: Scenario = { ...sc, services: sc.services.map((s) => (s.name === 'payment-api' ? { ...s, retries: 0 } : s)) };
  const recovered = tail(run(noRetry));
  assert.deepEqual(recovered.filter((v) => v >= threshold), [], `재시도 없음: ${recovered}`);
  assert.equal(recovered.length, 6);
});

test('의존성에 순환이 있으면 시뮬레이션을 시작하지 않는다', () => {
  assert.throws(
    () =>
      dependencyOrder([
        { name: 'a', capacityRps: 1, baseLatencyMs: 1, dependsOn: ['b'] },
        { name: 'b', capacityRps: 1, baseLatencyMs: 1, dependsOn: ['a'] },
      ]),
    /의존성 순환: a/,
  );
});

test('경보가 울리는 중에 기준의 2배를 넘으면 error 로 한 번만 올린다', () => {
  const sc = load('retry-storm');
  const alerts = run(sc).flatMap((e) => (e.type === 'alert' && e.service === 'payment-db' ? [e] : []));
  assert.deepEqual(
    alerts.map((e) => [sec(sc, e), e.payload.state, e.payload.level]),
    [
      [60, 'firing', 'warn'],
      [65, 'firing', 'error'],
    ],
  );
});
