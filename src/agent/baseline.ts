// 비교 기준: "첫 경보 직전의 가장 최근 배포 탓". 사람이 급할 때 제일 먼저 하는 추측
// 첫 경보 전에 배포가 없으면 그 뒤 첫 배포를 고른다. 배포가 아예 없으면 첫 경보가 울린 서비스의 degrade

import type { DeployEvent, SignalEvent } from '../events/schema.ts';
import type { Verdict } from './tools.ts';

export function latestDeployBaseline(events: SignalEvent[]): Verdict | undefined {
  const firstAlert = events.find((e) => e.type === 'alert' && e.payload.state === 'firing');
  const deploys = events.filter((e): e is DeployEvent => e.type === 'deploy');
  const cutoff = firstAlert?.at.getTime() ?? Infinity;
  const before = deploys.filter((d) => d.at.getTime() <= cutoff).at(-1);
  const pick = before ?? deploys[0];
  if (pick) return { service: pick.service, kind: 'deploy', evidence: `가장 최근 배포 ${pick.service} ${pick.payload.version}` };
  if (firstAlert) return { service: firstAlert.service, kind: 'degrade', evidence: '배포 없음, 첫 경보 서비스' };
  return undefined;
}

// 비교 기준 2: "처음 경보가 울린 서비스 탓". 그 서비스에 경보 전 배포가 있으면 deploy, 없으면 degrade
export function firstAlertBaseline(events: SignalEvent[]): Verdict | undefined {
  const firstAlert = events.find((e) => e.type === 'alert' && e.payload.state === 'firing');
  if (!firstAlert) return undefined;
  const deployed = events.some(
    (e) => e.type === 'deploy' && e.service === firstAlert.service && e.at.getTime() <= firstAlert.at.getTime(),
  );
  return { service: firstAlert.service, kind: deployed ? 'deploy' : 'degrade', evidence: `첫 경보 ${firstAlert.service}` };
}
