import { catalogueMetadata } from '../grid/catalogue-fixtures';
import type { CreativeWorkspaceChange, CreativeWorkspace, CreativeWorkspaceAsset, CreativePerformanceAsset, CreativeSyncSnapshot } from '@wizard-ads/shared';
import { period, profile } from '../synthetic-render-fixtures';
import Loading from '../shared-loading';
import SharedError from '../shared-error';
import Screen, { type ScreenData } from './view';

export const emptyWorkspace: CreativeWorkspace = { assets: [], campaigns: [], placements: [], changes: [], listingChanges: [], history: [], events: [], minClicks: null, targetAcos: null };
export const ready: Extract<ScreenData, { view: 'ready' }> = { view: 'ready', props: { profile, period, profileToday: '2026-08-29', selectedPresetId: undefined,
  workspace: emptyWorkspace, evidence: { producerEligible: false, latestJob: null, snapshot: null }, mode: 'list', tab: 'overview', selectedAssetId: null, campaignId: null, sbKeywordSyncEnabled: true } };

const performance = (id: string, orders: number, clicks = 210): CreativePerformanceAsset => ({
  assetId: id, attributionState: 'mapped', name: `Synthetic cut ${id.at(-1)}`, assetType: 'VIDEO', thumbnailUrl: null,
  campaignTypes: ['SB'], mappingProvenances: ['current_sb_ad_snapshot'], campaignCount: 1, adGroupCount: 1, adCount: 1, placementCount: 0,
  impressions: 8400, clicks, ctr: clicks / 8400, cost: 735, purchases: orders, sales: orders * 98, acos: 735 / (orders * 98), roas: orders * 98 / 735,
  videoFirstQuartileViews: 4410, videoMidpointViews: 3360, videoThirdQuartileViews: 2310, videoCompleteViews: 1260,
  drilldown: [{ keywordText: 'synthetic comparison phrase', keywordProvenance: 'synced', campaignId: 'synthetic-campaign-a', adGroupId: `synthetic-group-${id.at(-1)}`, adId: `synthetic-ad-${id.at(-1)}`, creativeId: `synthetic-creative-${id.at(-1)}`, creativeVersion: null, mappingProvenance: 'current_sb_ad_snapshot', placement: null, impressions: 8400, clicks, cost: 735, purchases: orders, sales: orders * 98, videoFirstQuartileViews: 4410, videoMidpointViews: 3360, videoThirdQuartileViews: 2310, videoCompleteViews: 1260 }],
});
const asset = (id: string, orders: number): CreativeWorkspaceAsset => ({ assetId: id, attributionState: 'mapped', name: `Synthetic cut ${id.at(-1)}`, assetType: 'VIDEO', thumbnailUrl: null, firstSeenAt: '2026-07-22T12:00:00.000Z', durationSeconds: null, width: null, height: null, advertisedAsin: null, moderation: null, campaignIds: ['synthetic-campaign-a'], placementCampaignIds: ['synthetic-campaign-a'], adGroupIds: [`synthetic-group-${id.at(-1)}`], performance: performance(id, orders) });
export function syntheticWorkspace(): CreativeWorkspace {
  return { assets: [asset('synthetic-asset-a', 21), asset('synthetic-asset-b', 63)],
    campaigns: [{ campaignId: 'synthetic-campaign-a', name: 'Synthetic comparison campaign', keywordText: 'synthetic comparison phrase', keywordProvenance: 'synced', keywordCount: 1,
      adGroups: [{ adGroupId: 'synthetic-group-a', name: 'Synthetic group A', assetIds: ['synthetic-asset-a'], unmappedCount: 0 }, { adGroupId: 'synthetic-group-b', name: 'Synthetic group B', assetIds: ['synthetic-asset-b'], unmappedCount: 0 }], modifiers: { topOfSearch: null, restOfSearch: null, productPages: null } }],
    placements: [{ campaignId: 'synthetic-campaign-a', placement: 'top_of_search', impressions: 8400, clicks: 210, cost: 735, sales: 2058, purchases: 21, modifier: null }],
    changes: ['first', 'window', 'exact'].map((kind, index): CreativeWorkspaceChange => ({ id: `synthetic-change-${index}`, assetIds: ['synthetic-asset-a'], campaignId: 'synthetic-campaign-a', adGroupId: index === 2 ? 'synthetic-group-a' : null, kind: index === 0 ? 'Creative' : index === 1 ? 'Placement' : 'Bid', field: index === 0 ? 'First seen' : index === 1 ? 'placement_bidding' : 'bid', oldValue: null, newValue: index === 0 ? 'Observed' : index === 1 ? { topOfSearch: 17 } : 1.37,
      observedAt: `2026-08-${String(19 + index).padStart(2, '0')}T12:00:00.000Z`, certainty: { kind: kind as 'first' | 'window' | 'exact', from: index === 0 ? null : `2026-08-${index === 1 ? '16' : '20'}T12:00:00.000Z`, to: `2026-08-${String(19 + index).padStart(2, '0')}T12:00:00.000Z`, widthDays: index === 0 ? null : index === 1 ? 4 : 1 }, scope: index === 2 ? 'Synthetic group A' : 'Synthetic comparison campaign', effect: index === 2 ? 'direct' : 'whole campaign' })).reverse(),
    listingChanges: [], history: Array.from({ length: 56 }, (_, index) => ({ date: new Date(Date.UTC(2026, 5, 1 + index)).toISOString().slice(0, 10), impressions: 8400, clicks: index < 28 ? 168 : 252, orders: index < 28 ? 21 : 35, spend: 735, sales: 2058 })), events: [], minClicks: 105, targetAcos: null };
}
const snapshot: CreativeSyncSnapshot = { id: '12121212-1212-4212-8212-121212121212', profileId: '13131313-1313-4313-8313-131313131313', startDate: period.start, endDate: period.end, observedAt: '2026-08-29T12:00:00.000Z', mappingProvenance: 'current_sb_ad_snapshot', historicalValidity: 'unproven_current_snapshot', status: 'completed', paginationComplete: true, factPromotionAllowed: true, sourceAssets: 2, parsedAssets: 2, sourceAds: 2, parsedAds: 2, mapped: 2, legacy: 0, unsupported: 0, ambiguous: 0, unmapped: 0, reportSourceRows: 2, reportParsedRows: 2, reportRefusedRows: 0, mappedFactRows: 2, unpromotedReportRows: 0 };

export const visualStates = ['pilot-off', 'no-facts', 'selected-asset', 'expired-thumbnail', 'quartiles-absent', 'keywords-provenance', 'keywords-sync-off', 'spend', 'placements', 'placements-unmeasured', 'history', 'campaign-clean', 'campaign-drifted', 'campaign-thin', 'verdict-cvr', 'verdict-ctr', 'floor-unmeasured', 'eligibility', 'loading', 'error', 'membership-gated', 'no-profiles', 'asset-unavailable'] as const;
export function visualFixture(state: string): ScreenData {
  if (state === 'membership-gated') return { view: 'gated', props: { entry: { state: 'no-database' } } };
  if (state === 'no-profiles') return { view: 'empty', props: {} };
  const data = structuredClone(ready);
  data.props.workspace = syntheticWorkspace();
  data.props.evidence = { producerEligible: state !== 'pilot-off', latestJob: null, snapshot };
  const workspace = data.props.workspace;
  if (state === 'no-facts') workspace.assets = [];
  if (state === 'selected-asset') data.props.selectedAssetId = 'synthetic-asset-b';
  if (state === 'expired-thumbnail') workspace.assets[0]!.thumbnailUrl = 'https://assets.example.test/expired.jpg?Expires=1';
  if (state === 'quartiles-absent') { const p = workspace.assets[0]!.performance!; p.videoFirstQuartileViews = null; p.videoMidpointViews = null; p.videoThirdQuartileViews = null; p.videoCompleteViews = null; }
  if (state.startsWith('keywords')) {
    data.props.mode = 'detail'; data.props.tab = 'keywords';
    for (const [suffix, provenance, text] of [['b', 'from_campaign_name', 'synthetic parsed phrase'], ['c', 'unresolved', null]] as const) {
      workspace.campaigns.push({ ...structuredClone(workspace.campaigns[0]!), campaignId: `synthetic-campaign-${suffix}`, name: `Synthetic campaign ${suffix}`, keywordText: text, keywordProvenance: provenance, keywordCount: text === null ? null : 1, adGroups: [] });
      workspace.assets[0]!.campaignIds.push(`synthetic-campaign-${suffix}`);
    }
    data.props.sbKeywordSyncEnabled = state !== 'keywords-sync-off';
  }
  if (state === 'spend') { data.props.mode = 'detail'; data.props.tab = 'spend'; }
  if (state.startsWith('placements')) { data.props.mode = 'detail'; data.props.tab = 'placements'; if (state === 'placements-unmeasured') workspace.placements = []; }
  if (state === 'history') { data.props.mode = 'detail'; data.props.tab = 'change-history'; }
  if (state.startsWith('campaign-') || state.startsWith('verdict-') || state === 'floor-unmeasured') {
    data.props.mode = 'campaign'; data.props.campaignId = 'synthetic-campaign-a';
    if (state === 'campaign-drifted') { workspace.campaigns[0]!.keywordCount = 2; workspace.campaigns[0]!.keywordText = null; workspace.campaigns[0]!.keywordProvenance = 'unresolved'; workspace.campaigns[0]!.adGroups[0]!.assetIds.push('synthetic-asset-b'); }
    if (state === 'campaign-thin') { workspace.assets[1]!.performance = performance('synthetic-asset-b', 1, 7); }
    if (state === 'floor-unmeasured') workspace.history = workspace.history.slice(0, 14);
    if (state === 'verdict-ctr') workspace.assets[1]!.performance = performance('synthetic-asset-b', 63, 630);
  }
  if (state === 'eligibility') data.props.mode = 'eligibility';
  if (state === 'asset-unavailable') { data.props.mode = 'detail'; data.props.selectedAssetId = 'missing-synthetic-asset'; }
  return data;
}
export function renderVisualFixture(state: string) {
  if (state === 'loading') return <Loading />;
  if (state === 'error') return <SharedError error={Object.assign(new Error('Synthetic failure'), { digest: 'synthetic-reference' })} reset={() => {}} />;
  return <Screen data={visualFixture(state)} />;
}

export function listingHistoryFixture() {
  const data=visualFixture('history');
  if(data.view!=='ready') throw new Error('Expected synthetic creative');
  const first=catalogueMetadata('SYNTHETIC4');
  data.props.workspace.assets[0]!.advertisedAsin=first.asin;
  data.props.workspace.listingChanges=[1,4].map((gap,index)=>{
    const previous={...first,sku:`synthetic-sku-${index}`,provenance:{...first.provenance,acquiredAt:'2026-09-10T00:00:00.000Z'}};
    const current={...previous,title:{state:'returned' as const,value:`Synthetic revision ${index}`,sourceField:'title'},provenance:{...first.provenance,acquiredAt:`2026-09-${10+gap}T00:00:00.000Z`}};
    return {id:`listing-${index}`,asin:first.asin,marketplaceId:first.scope.marketplaceId,previous,current};
  });
  return data;
}
