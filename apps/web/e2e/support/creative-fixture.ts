import { randomUUID } from 'node:crypto';
import { createDb, persistCreativePerformanceBatch } from '@wizard-ads/db';
import type { CreativeDailyFact } from '@wizard-ads/shared';
import type { E2EState } from './fixture';

export const CREATIVE_CAMPAIGN_ID = 'creative-e2e-campaign';
export const CREATIVE_ASSETS = ['creative-e2e-cut-a', 'creative-e2e-cut-b'] as const;
export const CREATIVE_NAMES = ['Synthetic opening scene', 'Synthetic close scene'] as const;

/** Seed only the suite-owned database, with the same counted persistence as ingestion. */
export async function seedCreativeWorkspace(state: E2EState): Promise<{ from: string; to: string }> {
  const db = createDb({ connectionString: state.connectionString });
  const now = new Date();
  const to = new Date(now.getTime() - 2 * 86_400_000).toISOString().slice(0, 10);
  const observedAt = now.toISOString();
  const snapshotId = randomUUID();
  try {
    const campaigns = await db.sql`
      insert into public.campaigns(org_id,profile_id,amazon_id,ad_product,name,state,budget_amount,budget_type)
      values (${state.orgId},${state.fixtureProfileId},${CREATIVE_CAMPAIGN_ID},'SB','Synthetic creative comparison','enabled',17,'daily')
      on conflict (profile_id,amazon_id) do update set name=excluded.name returning amazon_id`;
    if (campaigns.length !== 1) throw new Error('Creative browser fixture expected one campaign');
    const facts: CreativeDailyFact[] = [];
    for (const [index, assetId] of CREATIVE_ASSETS.entries()) {
      const adGroupId = `creative-e2e-group-${index}`;
      const adId = `creative-e2e-ad-${index}`;
      const groups = await db.sql`
        insert into public.ad_groups(org_id,profile_id,amazon_id,ad_product,name,state,campaign_id,default_bid)
        values (${state.orgId},${state.fixtureProfileId},${adGroupId},'SB',${`Synthetic group ${index + 1}`},'enabled',${CREATIVE_CAMPAIGN_ID},0.7)
        on conflict (profile_id,amazon_id) do update set name=excluded.name returning amazon_id`;
      const keywords = await db.sql`
        insert into public.keywords(org_id,profile_id,amazon_id,ad_product,state,campaign_id,ad_group_id,keyword_text,match_type,bid)
        values (${state.orgId},${state.fixtureProfileId},${`creative-e2e-keyword-${index}`},'SB','enabled',${CREATIVE_CAMPAIGN_ID},${adGroupId},'synthetic comparison query','exact',0.7)
        on conflict (profile_id,amazon_id) do update set keyword_text=excluded.keyword_text returning amazon_id`;
      if (groups.length !== 1 || keywords.length !== 1) throw new Error('Creative browser fixture lost an entity');
      facts.push({
        profileId: state.fixtureProfileId, date: to, adProduct: 'SB', campaignId: CREATIVE_CAMPAIGN_ID,
        adGroupId, adId, creativeId: `creative-e2e-identity-${index}`, creativeVersion: null, assetId,
        placement: null, attributionState: 'mapped', mappingProvenance: 'current_sb_ad_snapshot',
        creativeSyncSnapshotId: snapshotId, impressions: 1800 + index * 200, clicks: 54 + index * 8,
        cost: 36 - index * 7, purchases: 7 + index * 2, sales: 168 + index * 31,
        videoFirstQuartileViews: 1180, videoMidpointViews: 970, videoThirdQuartileViews: 710, videoCompleteViews: 460,
      });
    }
    const counts = await persistCreativePerformanceBatch(db, {
      orgId: state.orgId, profileId: state.fixtureProfileId,
      assets: CREATIVE_ASSETS.map((assetId, index) => ({
        profileId: state.fixtureProfileId, assetId, name: CREATIVE_NAMES[index] ?? '', assetType: 'VIDEO',
        contentHash: null, thumbnailUrl: null,
      })),
      mappings: facts.map((fact) => ({ sourceMappingKey: fact.adId, mapping: {
        profileId: fact.profileId, adProduct: fact.adProduct, campaignId: fact.campaignId,
        adGroupId: fact.adGroupId, adId: fact.adId, creativeId: fact.creativeId, creativeVersion: null,
        assetId: fact.assetId, placement: null, attributionState: fact.attributionState,
        mappingProvenance: fact.mappingProvenance, creativeSyncSnapshotId: snapshotId, observedAt,
      } })),
      facts,
      snapshot: {
        id: snapshotId, profileId: state.fixtureProfileId, startDate: to, endDate: to, observedAt,
        mappingProvenance: 'current_sb_ad_snapshot', historicalValidity: 'unproven_current_snapshot',
        status: 'completed', paginationComplete: true, factPromotionAllowed: true,
        sourceAssets: 2, parsedAssets: 2, sourceAds: 2, parsedAds: 2, mapped: 2,
        legacy: 0, unsupported: 0, ambiguous: 0, unmapped: 0,
        reportSourceRows: 2, reportParsedRows: 2, reportRefusedRows: 0, mappedFactRows: 2, unpromotedReportRows: 0,
      },
    });
    if (counts.assetsReadBack !== CREATIVE_ASSETS.length || counts.factsReadBack !== facts.length
      || counts.mappingsReadBack !== facts.length) throw new Error('Creative browser fixture counts did not reconcile');
    const placements = await db.sql`
      insert into public.creative_placements(org_id,asset_id,profile_id,campaign_id,ad_group_id,ad_id,state,started_at)
      select a.org_id,a.id,a.profile_id,${CREATIVE_CAMPAIGN_ID},
        case a.amazon_asset_id when ${CREATIVE_ASSETS[0]} then 'creative-e2e-group-0' else 'creative-e2e-group-1' end,
        case a.amazon_asset_id when ${CREATIVE_ASSETS[0]} then 'creative-e2e-ad-0' else 'creative-e2e-ad-1' end,
        'enabled',${to}::date
      from public.creative_assets a where a.org_id=${state.orgId} and a.profile_id=${state.fixtureProfileId}
        and a.amazon_asset_id in (${CREATIVE_ASSETS[0]},${CREATIVE_ASSETS[1]}) returning id`;
    if (placements.length !== CREATIVE_ASSETS.length) throw new Error('Creative browser fixture placement count did not reconcile');
    return { from: to, to };
  } finally { await db.close(); }
}
