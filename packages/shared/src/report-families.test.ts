import { describe, expect, it } from 'vitest';
import { CORE_REPORT_FAMILIES, CoreFeatureReportType, CoreReportConfiguration, CoreReportRow } from './report-families.js';
import { ReportType, WorkerReportType } from './jobs.js';

describe('tranche C contracts', () => {
  it('adds seventeen family and seven metric variants without changing six defaults', () => {
    expect(ReportType.options).toEqual(['spCampaigns', 'spTargeting', 'spSearchTerm', 'spPlacement', 'sbCampaigns', 'sdCampaigns']);
    expect(CoreFeatureReportType.options).toEqual([
      'spAdvertisedProduct', 'spPurchasedProduct', 'sbPurchasedProduct', 'sdPurchasedProduct',
      'sbTargeting', 'sbSearchTerm', 'sbCampaignPlacement', 'sbAdGroup',
      'sdAdGroup', 'sdAdGroupMatchedTarget', 'sdTargeting', 'sdTargetingMatchedTarget',
      'sdAdvertisedProduct', 'sdCampaignsMatchedTarget', 'spGrossAndInvalids', 'sbGrossAndInvalids', 'sdGrossAndInvalids',
      'spCampaignMetrics', 'spTargetMetrics', 'spQueryMetrics', 'spPlacementMetrics', 'sbCampaignMetrics', 'sdCampaignMetrics', 'sbAdMetrics',
    ]);
    expect(WorkerReportType.options).toHaveLength(31);
  });
  for (const family of CoreFeatureReportType.options) {
    const spec = CORE_REPORT_FAMILIES[family];
    it(`${family} refuses lost identity and unsupported columns for both time units`, () => {
      for (const timeUnit of ['DAILY', 'SUMMARY'] as const) {
        const dates = timeUnit === 'DAILY' ? ['date'] : ['startDate', 'endDate'];
        const configuration = { version: 1, family, timeUnit, format: 'GZIP_JSON', attributionGeneration: 'legacy', columns: [...dates, ...spec.required, ...spec.defaultMetrics] };
        expect(CoreReportConfiguration.safeParse(configuration).success).toBe(true);
        expect(CoreReportConfiguration.safeParse({ ...configuration, groupBy: ['unsupported'] }).success).toBe(false);
        expect(CoreReportConfiguration.safeParse({ ...configuration, timeUnit: 'HOURLY' }).success).toBe(false);
        expect(CoreReportConfiguration.safeParse({ ...configuration, format: 'CSV' }).success).toBe(false);
        expect(CoreReportConfiguration.safeParse({ ...configuration, columns: [...configuration.columns, 'unknownMetric'] }).success).toBe(false);
        const row = { family, periodStart: '2026-09-01', periodEnd: '2026-09-01', timeUnit, attributionGeneration: 'legacy', dimensions: Object.fromEntries(spec.required.map((key) => [key, 'synthetic'])), metrics: { [spec.defaultMetrics[0]!]: null }, identityResolution: 'reported_unresolved' };
        expect(CoreReportRow.safeParse(row).success).toBe(true);
        expect(CoreReportRow.safeParse({ ...row, dimensions: {} }).success).toBe(false);
        expect(CoreReportRow.safeParse({ ...row, metrics: { unknownMetric: 0 } }).success).toBe(false);
      }
    });
  }
  it('preserves purchased SB missing advertised identity and refuses purchased spend', () => {
    const row = { family: 'sbPurchasedProduct', periodStart: '2026-09-01', periodEnd: '2026-09-01', timeUnit: 'DAILY', attributionGeneration: 'legacy', dimensions: { campaignId: 'synthetic', purchasedAsin: 'synthetic-asin', advertisedAsin: null }, metrics: { sales: 0 }, identityResolution: 'reported_unresolved' };
    expect(CoreReportRow.parse(row).dimensions['advertisedAsin']).toBeNull();
    expect(CoreReportRow.safeParse({ ...row, metrics: { cost: 10 } }).success).toBe(false);
  });
});
