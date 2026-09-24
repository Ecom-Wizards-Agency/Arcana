import { describe, expect, it } from 'vitest';
import type { CreativeWorkspace, CreativeWorkspaceAsset, TimelineDaily } from '@wizard-ads/shared';
import { aggregateCreativeCampaigns, evaluateCreativeTest } from './performance.js';

function asset(id: string, group: string, clicks: number, orders: number): CreativeWorkspaceAsset {
  const metrics = { impressions: 1000, clicks, cost: 70, purchases: orders, sales: orders * 23,
    videoFirstQuartileViews: null, videoMidpointViews: null, videoThirdQuartileViews: null, videoCompleteViews: null };
  return { assetId: id, attributionState: 'mapped', name: id, assetType: 'VIDEO', thumbnailUrl: null,
    firstSeenAt: null, durationSeconds: null, width: null, height: null, advertisedAsin: null, moderation: null,
    campaignIds: ['campaign'], placementCampaignIds: ['campaign'], adGroupIds: [group], performance: { assetId: id, attributionState: 'mapped', name: id, assetType: 'VIDEO',
      thumbnailUrl: null, campaignTypes: ['SB'], mappingProvenances: [], campaignCount: 1, adGroupCount: 1, adCount: 1, placementCount: 0,
      ...metrics, ctr: clicks / 1000, acos: 70 / (orders * 23), roas: orders * 23 / 70,
      drilldown: [{ campaignId: 'campaign', adGroupId: group, adId: `ad-${id}`, creativeId: `creative-${id}`, creativeVersion: null,
        mappingProvenance: null, placement: null, keywordText: 'synthetic term', keywordProvenance: 'synced', ...metrics }] } };
}
function history(): TimelineDaily[] {
  return Array.from({ length: 42 }, (_, index) => ({ date: new Date(Date.UTC(2026, 5, 1 + index)).toISOString().slice(0, 10),
    spend: 70, sales: 230, clicks: 100, orders: 10, impressions: 1000 }));
}
function workspace(): CreativeWorkspace {
  return { assets: [asset('asset-one', 'group-one', 100, 10), asset('asset-two', 'group-two', 100, 20)],
    campaigns: [{ campaignId: 'campaign', name: 'Synthetic test', keywordText: 'synthetic term', keywordProvenance: 'synced', keywordCount: 1,
      adGroups: [{ adGroupId: 'group-one', name: null, assetIds: ['asset-one'], unmappedCount: 0 },
        { adGroupId: 'group-two', name: null, assetIds: ['asset-two'], unmappedCount: 0 }],
      modifiers: { topOfSearch: null, restOfSearch: null, productPages: null } }],
    placements: [], changes: [], listingChanges: [], history: history(), events: [], minClicks: 80, targetAcos: null };
}
describe('creative campaign comparison', () => {
  it('aggregates each campaign once and preserves absent completion', () => {
    const source = workspace().assets[0]!.performance!;
    source.drilldown.push({ ...source.drilldown[0]!, adId: 'another-ad', cost: 30 });
    source.cost += 30;
    const rows = aggregateCreativeCampaigns(source);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ cost: 100, clicks: 200, share: 1, videoCompleteViews: null });
    expect(aggregateCreativeCampaigns(null)).toEqual([]);
  });
  it('finds clean structure and CVR separation from this account history', () => {
    const result = evaluateCreativeTest(workspace(), 'campaign', '2026-08-01');
    expect(result.structure).toMatchObject({ state: 'clean', adGroupCount: 2, creativeCount: 2 });
    expect(result.cvr).toMatchObject({ floor: 0, separates: true, observedFortnights: 3 });
    expect(result.ctr).toMatchObject({ floor: 0, separates: false });
    expect(result.rows.map((row) => row.deliveryShare)).toEqual([0.5, 0.5]);
  });
  it('finds CTR separation while CVR stays equal', () => {
    const data = workspace(); data.assets[1] = asset('asset-two', 'group-two', 200, 20);
    const result = evaluateCreativeTest(data, 'campaign', '2026-08-01');
    expect(result.ctr.separates).toBe(true); expect(result.cvr.separates).toBe(false);
  });
  it('requires spread to exceed the relative noise floor, including equality', () => {
    const data = workspace(); data.assets[1] = asset('asset-two', 'group-two', 200, 20);
    data.history = data.history.map((day, index) => ({ ...day, clicks: index >= 14 && index < 28 ? 200 : 100, orders: index >= 14 && index < 28 ? 20 : 10 }));
    expect(evaluateCreativeTest(data, 'campaign', '2026-08-01').ctr).toMatchObject({ floor: 1, spread: 1, separates: false });
  });
  it('declares no verdict when the floor is not yet measured', () => {
    const data = workspace(); data.history = data.history.slice(0, 28);
    const result = evaluateCreativeTest(data, 'campaign', '2026-08-01');
    expect(result.cvr.separates).toBeNull(); expect(result.cvr.reason).toContain('not yet measured');
  });
  it('keeps thin and factless rows unmeasured without naming them losing', () => {
    const data = workspace(); data.assets[1] = asset('asset-two', 'group-two', 20, 2);
    let result = evaluateCreativeTest(data, 'campaign', '2026-08-01');
    expect(result.rows).toHaveLength(2); expect(result.rows[1]?.measured).toBe(false); expect(result.cvr.separates).toBeNull();
    data.assets[1]!.performance = null;
    result = evaluateCreativeTest(data, 'campaign', '2026-08-01');
    expect(result.rows[1]?.performance).toBeNull(); expect(result.rows[1]?.deliveryShare).toBeNull();
  });
  it('names structural drift and includes all creative and unmapped rows', () => {
    const data = workspace(); data.campaigns[0]!.keywordCount = 2;
    data.campaigns[0]!.adGroups[0]!.assetIds.push('asset-three'); data.campaigns[0]!.adGroups[0]!.unmappedCount = 1;
    const result = evaluateCreativeTest(data, 'campaign', '2026-08-01');
    expect(result.structure.state).toBe('drifted'); expect(result.structure.issues).toHaveLength(3);
    expect(result.rows).toHaveLength(4); expect(result.cvr.separates).toBeNull();
  });
  it('excludes account event windows and refuses missing evidence policy', () => {
    const data = workspace(); data.minClicks = null;
    expect(evaluateCreativeTest(data, 'campaign', '2026-08-01').rows.every((row) => !row.measured)).toBe(true);
    data.events = [{ id: 'synthetic-event', name: 'Observed account change', kind: 'market', start: '2026-06-03', end: '2026-06-06',
      status: 'recorded', scope: {}, scopeText: '', focus: 'ctr', note: '', actorId: null, createdAt: '2026-06-03T00:00:00Z', supersedesId: null }];
    expect(evaluateCreativeTest(data, 'campaign', '2026-08-01').ctr.floor).toBeNull();
  });
  it('does not prove structure from a parsed name or repeat one creative as two alternatives', () => {
    const data = workspace(); data.campaigns[0]!.keywordProvenance = 'from_campaign_name'; data.campaigns[0]!.keywordCount = null;
    let result = evaluateCreativeTest(data, 'campaign', '2026-08-01');
    expect(result.structure.state).toBe('unmeasured'); expect(result.cvr.separates).toBeNull();
    data.campaigns[0]!.keywordCount = 1; data.campaigns[0]!.adGroups[1]!.assetIds = ['asset-one'];
    result = evaluateCreativeTest(data, 'campaign', '2026-08-01');
    expect(result.structure.state).toBe('drifted'); expect(result.structure.issues[0]).toContain('same creative');
  });
});
