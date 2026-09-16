import { expect, it } from 'vitest';
import type { CoreReportRow } from '@wizard-ads/shared';
import { aggregateReportMetrics } from './report-metrics.js';
const row = (cost: number | null, sales: number | null): CoreReportRow => ({ family: 'sbAdGroup', timeUnit: 'DAILY', periodStart: '2026-09-01', periodEnd: '2026-09-01', dimensions: { campaignId: 'synthetic', adGroupId: 'synthetic' }, metrics: { cost, sales }, attributionGeneration: 'legacy', identityResolution: 'reported_unresolved' });
it('computes a ratio from compatible sums and preserves missing and zero evidence', () => {
  expect(aggregateReportMetrics([row(10, 100), row(10, 20)], 'cost', 'sales').ratio).toBe(20 / 120);
  expect(aggregateReportMetrics([row(0, 100)], 'cost', 'sales').ratio).toBe(0);
  expect(aggregateReportMetrics([row(10, null), row(10, 20)], 'cost', 'sales').ratio).toBeNull();
  expect(aggregateReportMetrics([row(0, 0)], 'cost', 'sales').ratio).toBeNull();
  expect(() => aggregateReportMetrics([row(1, 10), { ...row(1, 10), attributionGeneration: 'multi_touch_v1' }], 'cost', 'sales')).toThrow(/incompatible/);
});
