import { readCoreReportEvidence, type QueryHandle } from '@wizard-ads/db';
import { coreReportIdentity, type CoreFeatureReportType, type CoreReportEvidence, type CoreReportRow } from '@wizard-ads/shared';
import type { EntityLevel, GridRow } from '@wizard-ads/ui';

export const GRID_CORE_FAMILIES: Record<EntityLevel, readonly CoreFeatureReportType[]> = {
  products: ['spAdvertisedProduct', 'sdAdvertisedProduct', 'spPurchasedProduct', 'sbPurchasedProduct', 'sdPurchasedProduct'],
  campaigns: ['spCampaignMetrics', 'sbCampaignMetrics', 'sdCampaignMetrics', 'spGrossAndInvalids', 'sbGrossAndInvalids', 'sdGrossAndInvalids', 'sdCampaignsMatchedTarget'],
  ad_groups: ['sbAdGroup', 'sdAdGroup'], targets: ['spTargetMetrics', 'sbTargeting', 'sdTargeting'],
  search_terms: ['spQueryMetrics', 'sbSearchTerm'], placements: ['spPlacementMetrics', 'sbCampaignPlacement'],
};
const metricKeys = { impressions: 'impressions', clicks: 'clicks', spend: 'cost', sales: 'sales', orders: 'purchases', units: 'unitsSold' } as const;
export function coreEvidenceGridRows(evidence: readonly CoreReportEvidence[], currencyCode: string): GridRow[] {
  const result: GridRow[] = [];
  for (const item of evidence) {
    if (item.variant && item.variant !== 'DAILY:legacy:v1') continue;
    if (!['ad_group', 'sb_target', 'sd_target', 'sb_search_term', 'sb_placement'].includes(item.grain) && !['sbCampaignMetrics', 'sdCampaignMetrics', 'sdAdvertisedProduct'].includes(item.family)) continue;
    const groups = new Map<string, CoreReportRow[]>();
    for (const row of item.rows) {
      const key = item.family === 'sdAdvertisedProduct' ? JSON.stringify({ advertisedAsin: row.dimensions['advertisedAsin'] }) : JSON.stringify(coreReportIdentity(row));
      const group = groups.get(key) ?? []; group.push(row); groups.set(key, group);
    }
    for (const [key, rows] of groups) {
      const d = rows[0]!.dimensions;
      const missing: (keyof typeof metricKeys)[] = [];
      const totals = { impressions: 0, clicks: 0, spend: 0, sales: 0, orders: 0, units: 0 };
      for (const metric of Object.keys(metricKeys) as (keyof typeof metricKeys)[]) {
        const values = rows.map((row) => row.metrics[metricKeys[metric]]);
        if (values.some((value) => value == null)) missing.push(metric);
        else totals[metric] = values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
      }
      result.push({ id: `${item.family}:${key}`, currencyCode, totals, comparison: null, measurement: { missing, comparisonMissing: [] }, dimensions: {
        asin: d['advertisedAsin'] ?? null, campaign_id: item.family === 'sdAdvertisedProduct' ? null : d['campaignId'] ?? null, ad_group_id: item.family === 'sdAdvertisedProduct' ? null : d['adGroupId'] ?? null, target_id: d['keywordId'] ?? d['targetingId'] ?? null,
        targeting: d['keywordText'] ?? d['targetingExpression'] ?? null, search_term: d['searchTerm'] ?? null, placement: d['placementClassification'] ?? null,
        match_type: d['matchType'] ?? null, ad_product: item.family.startsWith('sb') ? 'SB' : 'SD', evidence_status: item.status, report_family: item.family, attribution_generation: rows[0]!.attributionGeneration,
      } });
    }
  }
  return result;
}
export function loadCoreGridEvidence(handle: QueryHandle, level: EntityLevel, input: { orgId: string; profileId: string; startDate: string; endDate: string; limit?: number }) {
  return readCoreReportEvidence(handle, { ...input, families: GRID_CORE_FAMILIES[level] });
}
