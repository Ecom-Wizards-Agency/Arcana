import type { CreativeSyncPolicy, CreativeWorkspace, SpEvidence, SpParsedReport, StreamConsumerEvidence } from '@wizard-ads/shared';
import { readListingEvidence, readCoreReportEvidence, readCreativeWorkspace, readSpReportEvidence, readSpListingHistory, readLatestCreativeSyncJobState, readLatestCreativeSyncSnapshot, readProviderEvidence } from '@wizard-ads/db';
import { readStreamConsumerEvidence } from '../creative/stream-evidence-load';
import { deriveAssetEligibility } from '@wizard-ads/core';
import type { ScreenActor } from '../../server/page-read';
import type { ScreenParams } from '../types';
import { producerEligibility, type CreativeLifecycleEvidence } from '../../creative/lifecycle';
import { creativeSyncPolicyFromEnv } from '../../server/sync-tick';
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
  const [workspace, snapshot, latestJob, listingEvidence, listingReports, coreEvidence, ownListingEvidence] = await access.readSql(async (sql) => Promise.all([
    readCreativeWorkspace({ sql }, { orgId, profileId: profile.id, from: period.start, to: period.end }),
    readLatestCreativeSyncSnapshot({ sql }, { orgId, profileId: profile.id }),
    readLatestCreativeSyncJobState({ sql }, { orgId, profileId: profile.id }),
    readSpReportEvidence({ sql }, { orgId, profileId: profile.id, family: 'catalogue', start: period.start, end: period.end }),
    readSpListingHistory({ sql }, { orgId, profileId: profile.id, start: period.start, end: period.end }),
    readCoreReportEvidence({ sql }, { orgId, profileId: profile.id, startDate: period.start, endDate: period.end, families: ['sbAdMetrics'], limit: 1000 }),
    readListingEvidence({ sql }, { orgId, profileId: profile.id, asOf: new Date().toISOString(), maxAgeMs: 86400000 }),
  ]));
  const displayedWorkspace: CreativeWorkspace = { ...workspace, listingCoverage: {
    measuredFields: ownListingEvidence.reduce((n,e)=>n+e.fields.filter((f)=>f.availability==='measured').length,0),
    staleFields: ownListingEvidence.reduce((n,e)=>n+e.fields.filter((f)=>f.availability==='stale').length,0),
  } };
  const now = new Date().toISOString();
  for (const asset of workspace.assets) {
    asset.eligibility = [];
    for (const evidence of asset.assetLibraryEvidence ?? []) {
      const contexts = new Map((asset.moderationEvidence ?? []).map((row) => [JSON.stringify(row.observation.context), row.observation.context]));
      for (const context of contexts.values()) asset.eligibility.push(deriveAssetEligibility({ context,
        identity: evidence.observation.identity, now, asset: evidence, moderation: asset.moderationEvidence ?? [] }));
    }
    if (asset.eligibility.length === 1) asset.moderation = asset.eligibility[0]!.status;
  }
  const streamEvidence = await access.readSql((sql) => readStreamConsumerEvidence({ sql }, {
    orgId, profileId: profile.id, datasets: ['ads-campaign-management-ads', 'sb-clickstream', 'sb-rich-media'],
    asOf: now, maxAgeMs: 86400000, from: `${period.start}T00:00:00.000Z`,
    to: new Date(Date.parse(`${period.end}T00:00:00.000Z`) + 86400000).toISOString(),
    assetId: mode === 'detail' ? input.params['assetId'] ?? one(input.searchParams['asset']) ?? null : null,
    campaignId: mode === 'campaign' ? input.params['campaignId'] ?? null : null,
  }));
  const policy: CreativeSyncPolicy = creativeSyncPolicyFromEnv(process.env, profile.syncEnabled);
  const evidence: CreativeLifecycleEvidence = { ...producerEligibility(policy), snapshot, latestJob };
  const requestedTab = one(input.searchParams['tab']);
  const tab: CreativeTab = creativeTabs.find((value) => value === requestedTab) ?? 'overview';
  return { view: 'ready' as const, props: { ...(providerEvidence ? { providerEvidence } : {}), ...({ listingEvidence, listingReports } as { listingEvidence?: SpEvidence; listingReports?: SpParsedReport[] }), profile, period, profileToday, selectedPresetId, workspace: displayedWorkspace, evidence, ...({ streamEvidence } as { streamEvidence?: StreamConsumerEvidence }), mode, tab, ...(coreEvidence.some((item) => item.status !== 'unmeasured') ? { coreEvidence } : {}),
    selectedAssetId: input.params['assetId'] ?? one(input.searchParams['asset']) ?? null,
    campaignId: input.params['campaignId'] ?? null,
    sbKeywordSyncEnabled: process.env['OPENSPELL_SB_KEYWORD_SYNC_ENABLED'] === '1',
  } };
}
