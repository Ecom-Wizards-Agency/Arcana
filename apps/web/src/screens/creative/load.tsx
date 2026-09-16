import type { SpEvidence, SpParsedReport } from '@wizard-ads/shared';
import { readCoreReportEvidence, readCreativeWorkspace, readSpReportEvidence, readSpListingHistory, readLatestCreativeSyncJobState, readLatestCreativeSyncSnapshot } from '@wizard-ads/db';
import { readProviderEvidence } from '@wizard-ads/db';
import type { ScreenActor } from '../../server/page-read';
import type { ScreenParams } from '../types';
import type { CreativeLifecycleEvidence } from '../../creative/lifecycle';
import { creativeSyncPilotFromEnv } from '../../server/sync-tick';
import { periodFromParamsThroughToday, todayIsoInTimeZone } from '../../../app/_lib/periods';
import { listProfiles } from '../../../app/_lib/profiles';

export type CreativeMode = 'list' | 'detail' | 'campaign' | 'eligibility';
export const creativeTabs = ['overview', 'keywords', 'spend', 'placements', 'change-history'] as const;
export type CreativeTab = typeof creativeTabs[number];
const one = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;

export async function load(access: ScreenActor, input: ScreenParams) { return loadCreativeScreen(access, input, 'list'); }

export async function loadCreativeScreen(access: ScreenActor, input: ScreenParams, mode: CreativeMode) {
  const entry = access.entry;
  if (entry.state !== 'ok') return { view: 'gated' as const, props: { entry } };
  const orgId = entry.context.active?.orgId ?? '';
  const profiles = await access.readSql((sql) => listProfiles({ sql }, orgId));
  const profile = access.selectProfile(profiles);
  if (profile === null) return { view: 'empty' as const, props: {} };
  const providerEvidence = await access.readSql((sql) => readProviderEvidence({ sql }, { orgId, profileId: profile.id, consumer: 'creative' }));
  const profileToday = todayIsoInTimeZone(profile.timezone);
  const from = one(input.searchParams['from']), to = one(input.searchParams['to']);
  const period = periodFromParamsThroughToday({ ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) }, profileToday);
  const selectedPresetId = one(input.searchParams['preset']);
  const [workspace, snapshot, latestJob, listingEvidence, listingReports, coreEvidence] = await access.readSql(async (sql) => Promise.all([
    readCreativeWorkspace({ sql }, { orgId, profileId: profile.id, from: period.start, to: period.end }),
    readLatestCreativeSyncSnapshot({ sql }, { orgId, profileId: profile.id }),
    readLatestCreativeSyncJobState({ sql }, { orgId, profileId: profile.id }),
    readSpReportEvidence({ sql }, { orgId, profileId: profile.id, family: 'catalogue', start: period.start, end: period.end }),
    readSpListingHistory({ sql }, { orgId, profileId: profile.id, start: period.start, end: period.end }),
    readCoreReportEvidence({ sql }, { orgId, profileId: profile.id, startDate: period.start, endDate: period.end, families: ['sbAdMetrics'], limit: 1000 }),
  ]));
  const pilot = creativeSyncPilotFromEnv();
  const evidence: CreativeLifecycleEvidence = {
    producerEligible: profile.syncEnabled && pilot.enabled && pilot.profileIds.includes(profile.id.toLowerCase()),
    snapshot, latestJob,
  };
  const requestedTab = one(input.searchParams['tab']);
  const tab: CreativeTab = creativeTabs.find((value) => value === requestedTab) ?? 'overview';
  return { view: 'ready' as const, props: { ...(providerEvidence ? { providerEvidence } : {}), ...({ listingEvidence, listingReports } as { listingEvidence?: SpEvidence; listingReports?: SpParsedReport[] }), profile, period, profileToday, selectedPresetId, workspace, evidence, mode, tab, ...(coreEvidence.some((item) => item.status !== 'unmeasured') ? { coreEvidence } : {}),
    selectedAssetId: input.params['assetId'] ?? one(input.searchParams['asset']) ?? null,
    campaignId: input.params['campaignId'] ?? null,
    sbKeywordSyncEnabled: process.env['OPENSPELL_SB_KEYWORD_SYNC_ENABLED'] === '1',
  } };
}
