import type {
  CreativeCampaignPerformance, CreativeMetricVerdict, CreativePerformanceAsset,
  CreativePerformanceDrilldown, CreativeTest, CreativeTestRow, CreativeWorkspace,
} from '@wizard-ads/shared';
import { timelineNoiseFloor } from '../timeline-effect.js';

const ratio = (numerator: number, denominator: number) => denominator > 0 ? numerator / denominator : null;

function totals(rows: readonly CreativePerformanceDrilldown[], campaignId: string, spend: number): CreativeCampaignPerformance | null {
  if (!rows.length) return null;
  const sum = (key: 'impressions' | 'clicks' | 'cost' | 'purchases' | 'sales') => rows.reduce((n, row) => n + row[key], 0);
  const impressions = sum('impressions'), clicks = sum('clicks'), cost = sum('cost'), purchases = sum('purchases'), sales = sum('sales');
  return { campaignId, impressions, clicks, cost, purchases, sales,
    ctr: ratio(clicks, impressions), cvr: ratio(purchases, clicks), cpc: ratio(cost, clicks), acos: ratio(cost, sales), share: ratio(cost, spend),
    videoCompleteViews: rows.some((row) => row.videoCompleteViews === null) ? null : rows.reduce((n, row) => n + row.videoCompleteViews!, 0) };
}

/** One campaign row, regardless of the number of ads, groups or keyword entities. */
export function aggregateCreativeCampaigns(performance: CreativePerformanceAsset | null): CreativeCampaignPerformance[] {
  if (performance === null) return [];
  const groups = new Map<string, CreativePerformanceDrilldown[]>();
  for (const row of performance.drilldown) groups.set(row.campaignId, [...(groups.get(row.campaignId) ?? []), row]);
  return [...groups].map(([campaignId, rows]) => totals(rows, campaignId, performance.cost)!)
    .sort((a, b) => b.cost - a.cost || a.campaignId.localeCompare(b.campaignId));
}

/** Roster drives the comparison: thin, unmapped and factless rows stay visible. */
export function evaluateCreativeTest(workspace: CreativeWorkspace, campaignId: string, beforeDate: string): CreativeTest {
  const campaign = workspace.campaigns.find((item) => item.campaignId === campaignId);
  const groups = campaign?.adGroups ?? [];
  const issues: string[] = [];
  if (campaign?.keywordCount !== 1) issues.push(campaign?.keywordCount === null || campaign === undefined
    ? 'The campaign keyword count is not measured' : `${campaign.keywordCount} keywords in this campaign`);
  if (!groups.length) issues.push('No ad groups are observed');
  for (const group of groups) {
    if (group.assetIds.length !== 1) issues.push(`${group.name ?? group.adGroupId}: ${group.assetIds.length} creatives`);
    if (group.unmappedCount) issues.push(`${group.name ?? group.adGroupId}: ${group.unmappedCount} unmapped ads`);
  }
  const creativeGroups = new Map<string, number>();
  for (const group of groups) for (const assetId of new Set(group.assetIds)) creativeGroups.set(assetId, (creativeGroups.get(assetId) ?? 0) + 1);
  for (const [assetId, count] of creativeGroups) if (count > 1) issues.push(`${assetId}: the same creative appears in ${count} ad groups`);
  const knownDrift = (campaign?.keywordCount != null && campaign.keywordCount !== 1)
    || groups.some((group) => group.assetIds.length !== 1 || group.unmappedCount > 0)
    || [...creativeGroups.values()].some((count) => count > 1);
  const structureState = knownDrift ? 'drifted' : !campaign || !groups.length || campaign.keywordCount === null ? 'unmeasured' : 'clean';
  const roster = groups.flatMap((group) => [
    ...group.assetIds.map((assetId) => ({ group, assetId })),
    ...(group.unmappedCount || !group.assetIds.length ? [{ group, assetId: null }] : []),
  ]);
  const rows: CreativeTestRow[] = roster.map(({ group, assetId }) => {
    const assets = workspace.assets.filter((asset) => asset.assetId === assetId);
    const source = assets.flatMap((asset) => asset.performance?.drilldown ?? [])
      .filter((row) => row.campaignId === campaignId && row.adGroupId === group.adGroupId);
    const performance = totals(source, campaignId, 0);
    const unmeasuredReason = assetId === null ? 'No authoritative asset mapping'
      : performance === null ? 'No ad-grain facts'
      : workspace.minClicks === null ? 'Account evidence threshold is not set'
      : performance.clicks < workspace.minClicks ? 'Below the account click threshold' : null;
    return { assetId, adGroupId: group.adGroupId, name: assets[0]?.name ?? null, adGroupName: group.name,
      thumbnailUrl: assets[0]?.thumbnailUrl ?? null, performance,
      measured: unmeasuredReason === null, unmeasuredReason, deliveryShare: null };
  });
  const delivered = rows.reduce((sum, row) => sum + (row.performance?.impressions ?? 0), 0);
  for (const row of rows) row.deliveryShare = row.performance === null ? null : ratio(row.performance.impressions, delivered);
  const metric = (name: 'ctr' | 'cvr'): CreativeMetricVerdict => {
    const noise = timelineNoiseFloor(workspace.history, name, workspace.events, beforeDate);
    const values = rows.filter((row) => row.measured).flatMap((row) => row.performance?.[name] == null ? [] : [row.performance[name]!]);
    const min = values.length ? Math.min(...values) : 0;
    const spread = values.length < 2 || min <= 0 ? null : Math.max(...values) / min - 1;
    const reason = structureState === 'drifted' ? 'The campaign structure has drifted; no verdict is declared'
      : structureState === 'unmeasured' ? 'Campaign structure is not yet measured; no verdict is declared'
      : noise.value === null ? `Account noise floor is not yet measured (${noise.calibration.coverage})`
      : spread === null ? 'A relative spread needs at least two measured creatives and a nonzero lower rate' : null;
    return { metric: name, spread, floor: noise.value, separates: reason === null ? spread! > noise.value! : null,
      reason, observedFortnights: noise.calibration.observed, requiredFortnights: noise.calibration.required };
  };
  return { campaignId, rows, ctr: metric('ctr'), cvr: metric('cvr'), structure: {
    state: structureState, issues,
    keywordCount: campaign?.keywordCount ?? null, adGroupCount: groups.length,
    creativeCount: new Set(groups.flatMap((group) => group.assetIds)).size,
  } };
}
