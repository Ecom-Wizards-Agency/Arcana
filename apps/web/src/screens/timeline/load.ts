import { readStreamConsumerEvidence } from '../creative/stream-evidence-load';
import { readTimeline } from '@wizard-ads/db';
import type { TimelineSnapshot, StreamConsumerEvidence } from '@wizard-ads/shared';
import { parseGridView } from '@wizard-ads/shared';
import { periodFromParams, todayIso } from '../../../app/_lib/periods';
import { listProfiles } from '../../../app/_lib/profiles';
import type { ScreenActor } from '../../server/page-read';
import type { ScreenParams } from '../types';
export type TimelineData = { view: 'gated' } | { view: 'empty' } | {
  view: 'ready'; profileId: string; currencyCode: string; countryCode: string; canEdit: boolean;
  start: string; end: string; streamEvidence?: StreamConsumerEvidence; snapshot: TimelineSnapshot; savedView: ReturnType<typeof parseGridView>;
};
export async function load(access: ScreenActor, input: ScreenParams): Promise<TimelineData> {
  if (access.entry.state !== 'ok') return { view: 'gated' };
  const role = access.entry.context.active?.role;
  const savedView = parseGridView(typeof input.searchParams['view'] === 'string' ? input.searchParams['view'] : null);
  const from = typeof input.searchParams['from'] === 'string' ? input.searchParams['from'] : savedView?.dateRange?.start;
  const to = typeof input.searchParams['to'] === 'string' ? input.searchParams['to'] : savedView?.dateRange?.end;
  const period = periodFromParams({from,to},todayIso());
  return access.snapshot(async (snapshot) => {
    const handle = { sql: snapshot.sql };
    const profiles = await listProfiles(handle,snapshot.actor.orgId);
    const profile = access.selectProfile(profiles);
    if (!profile) return { view: 'empty' };
    return { view:'ready',profileId:profile.id,currencyCode:profile.currencyCode,countryCode:profile.countryCode,canEdit:role==='owner'||role==='admin'||role==='analyst',
      start:period.start,end:period.end,streamEvidence:await readStreamConsumerEvidence(handle,{orgId:snapshot.actor.orgId,profileId:profile.id,datasets:['ads-campaign-management-campaigns','ads-campaign-management-adgroups','ads-campaign-management-ads','ads-campaign-management-targets'],asOf:new Date().toISOString(),maxAgeMs:86400000,history:true,from:`${period.start}T00:00:00.000Z`,to:new Date(Date.parse(`${period.end}T00:00:00.000Z`)+86400000).toISOString()}),snapshot:await readTimeline(handle,snapshot.actor.orgId,profile.id),savedView };
  });
}
