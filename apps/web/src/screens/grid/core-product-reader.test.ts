import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@wizard-ads/db/testing';
import { promoteCoreReportWindow } from '@wizard-ads/db';
import { CORE_REPORT_FAMILIES, type CoreReportConfiguration, type CoreReportPromotion } from '@wizard-ads/shared';
import { loadGridRows } from '../../../app/_lib/grid-data';

let database: TestDatabase;
let orgId: string;
let profileId: string;
beforeAll(async () => {
  database = await createTestDatabase('wp310_products');
  const [org] = await database.sql`select app.seed_tenant_fixture('synthetic-products',${randomUUID()},'owner') as id`;
  orgId = org!['id'] as string;
  const [profile] = await database.sql`select id from public.ad_profiles where org_id=${orgId} limit 1`;
  profileId = profile!['id'] as string;
}, 120000);
afterAll(async () => { await database?.drop(); });
it('measures two exact ASINs in one ad group while an unreported product stays missing', async () => {
  const family = 'spAdvertisedProduct';
  const spec = CORE_REPORT_FAMILIES[family];
  const configuration: CoreReportConfiguration = { family, version: 1, timeUnit: 'DAILY', format: 'GZIP_JSON', attributionGeneration: 'legacy', columns: ['date', ...spec.required, ...spec.optional, ...spec.defaultMetrics] };
  const asins = ['B000000011', 'B000000012', 'B000000013'];
  for (const [i, asin] of asins.entries()) await database.sql`insert into public.product_ads(org_id,profile_id,amazon_id,ad_product,campaign_id,ad_group_id,asin,state) values(${orgId},${profileId},${`synthetic-${i}`},'SP','c-1','ag-1',${asin},'enabled')`;
  const requestId = randomUUID();
  const requestedAt = '2026-09-02T00:00:00.000Z';
  await database.sql`insert into public.report_requests(id,org_id,profile_id,report_type,start_date,end_date,requested_at,family_configuration) values(${requestId},${orgId},${profileId},${family},'2026-09-01','2026-09-01',${requestedAt},${JSON.stringify(configuration)}::jsonb)`;
  const rows: CoreReportPromotion['parsed']['rows'] = asins.slice(0, 2).map((asin, i) => ({ family, timeUnit: 'DAILY', periodStart: '2026-09-01', periodEnd: '2026-09-01', attributionGeneration: 'legacy', identityResolution: 'reported_unresolved', dimensions: { campaignId: 'c-1', adGroupId: 'ag-1', advertisedAsin: asin, adId: `synthetic-${i}`, advertisedSku: null }, metrics: { impressions: 10, clicks: i, cost: i * 3, purchases7d: 0, sales7d: 0, unitsSoldClicks7d: 0 } }));
  const promotion: CoreReportPromotion = { orgId, profileId, reportRequestId: requestId, requestedAt, observedAt: requestedAt, startDate: '2026-09-01', endDate: '2026-09-01', parsed: { configuration, sourceRows: 2, parsedRows: 2, duplicateRows: 0, rows, refusals: [] } };
  expect((await database.sql.begin((sql) => promoteCoreReportWindow({ sql }, promotion))).loadedRows).toBe(2);
  const result = await loadGridRows(database, 'products', { orgId, profileId, currencyCode: 'USD', period: { start: '2026-09-01', end: '2026-09-01' }, comparison: { start: '2026-08-31', end: '2026-08-31' } });
  const actual = asins.map((asin) => result.rows.find((row) => row.dimensions['asin'] === asin));
  expect(actual).toHaveLength(3);
  expect(actual[0]?.totals.spend).toBe(0);
  expect(actual[0]?.measurement?.missing ?? []).not.toContain('spend');
  expect(actual[1]?.totals.spend).toBe(3);
  expect(actual[2]?.measurement?.missing).toContain('spend');
  expect(result.rows.reduce((sum, row) => sum + row.totals.spend, 0)).toBe(3);
});
