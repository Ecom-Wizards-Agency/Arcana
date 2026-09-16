import { readTimeline, readSpListingHistory, readSpReportEvidence } from '@wizard-ads/db';
import type { TimelineSnapshot, SpEvidence, SpParsedReport } from '@wizard-ads/shared';
import { parseGridView } from '@wizard-ads/shared';
import { periodFromParams, todayIso } from '../../../app/_lib/periods';
import { listProfiles } from '../../../app/_lib/profiles';
import type { ScreenActor } from '../../server/page-read';
import type { ScreenParams } from '../types';
export type TimelineData = { view: 'gated' } | { view: 'empty' } | {
  view: 'ready'; profileId: string; currencyCode: string; countryCode: string; canEdit: boolean;
  listingEvidence?: SpEvidence; listingReports?: SpParsedReport[]; timezone?: string;
  start: string; end: string; snapshot: TimelineSnapshot; savedView: ReturnType<typeof parseGridView>;
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
    const listingEvidence = await readSpReportEvidence(handle, { orgId: snapshot.actor.orgId, profileId: profile.id, family: 'catalogue', start: period.start, end: period.end });
    const listingReports = await readSpListingHistory(handle, { orgId: snapshot.actor.orgId, profileId: profile.id, start: period.start, end: period.end });
    return { view:'ready', listingEvidence, listingReports, timezone: profile.timezone,profileId:profile.id,currencyCode:profile.currencyCode,countryCode:profile.countryCode,canEdit:role==='owner'||role==='admin'||role==='analyst',
      start:period.start,end:period.end,snapshot:await readTimeline(handle,snapshot.actor.orgId,profile.id),savedView };
  });
}
