import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { CORE_REPORT_FAMILIES, type CoreReportConfiguration, type CoreReportPromotion } from '@wizard-ads/shared';
import { createTestDatabase, type TestDatabase } from './testing/harness.js';
import { coreReportGrain, promoteCoreReportWindow, readCoreReportEvidence } from './queries/report-families.js';
import { upsertReportCoverage } from './queries/report-coverage.js';

let db: TestDatabase;
let orgId: string;
let profileId: string;
let sequence = 0;
beforeAll(async () => { db = await createTestDatabase('wp310_evidence_rework'); }, 120000);
afterAll(async () => { await db?.drop(); });
beforeEach(async () => {
  const [org] = await db.sql`select app.seed_tenant_fixture(${`synthetic-evidence-${randomUUID()}`},${randomUUID()},'owner') as id`;
  orgId = org!['id'] as string;
  const [profile] = await db.sql`select id from public.ad_profiles where org_id=${orgId} limit 1`;
  profileId = profile!['id'] as string;
});
async function persist(start: string, end: string, timeUnit: 'DAILY' | 'SUMMARY', reverse = false) {
  const spec = CORE_REPORT_FAMILIES.sbAdGroup;
  const columns = [...(timeUnit === 'DAILY' ? ['date'] : ['startDate','endDate']), ...spec.required, ...spec.defaultMetrics];
  const configuration: CoreReportConfiguration = { family: 'sbAdGroup', version: 1, timeUnit, format: 'GZIP_JSON', attributionGeneration: 'legacy', columns: reverse ? columns.reverse() : columns };
  const id = randomUUID();
  const at = new Date(Date.parse('2026-09-20T00:00:00.000Z') + ++sequence * 1000).toISOString();
  await db.sql`insert into public.report_requests(id,org_id,profile_id,report_type,start_date,end_date,requested_at,family_configuration) values(${id},${orgId},${profileId},'sbAdGroup',${start},${end},${at},${JSON.stringify(configuration)}::jsonb)`;
  const promotion: CoreReportPromotion = { orgId, profileId, reportRequestId: id, requestedAt: at, observedAt: at, startDate: start, endDate: end, parsed: { configuration, sourceRows: 1, parsedRows: 1, duplicateRows: 0, refusals: [], rows: [{ family: 'sbAdGroup', timeUnit, attributionGeneration: 'legacy', periodStart: start, periodEnd: end, identityResolution: 'reported_unresolved', dimensions: { campaignId: 'synthetic-c', adGroupId: 'synthetic-g' }, metrics: { cost: 7 } }] } };
  await db.sql.begin(async (sql) => {
    expect((await promoteCoreReportWindow({ sql }, promotion)).loadedRows).toBe(1);
    await upsertReportCoverage({ sql }, { orgId, profileId, reportType: 'sbAdGroup', grain: coreReportGrain(configuration), source: 'amazon_reporting_v3', status: 'complete', earliestDate: start, coveredThrough: end, settledThrough: null, sourceRows: 1, parsedRows: 1, refusedRows: 0, loadedRows: 1, countsMatch: true, observedAt: at }, 1);
  });
}
const read = (startDate = '2026-09-01', endDate = '2026-09-10') => readCoreReportEvidence(db, { orgId, profileId, families: ['sbAdGroup'], startDate, endDate });
it('reads reordered equivalent configurations once with one row and unchanged spend', async () => {
  await persist('2026-09-01','2026-09-01','DAILY');
  await persist('2026-09-01','2026-09-01','DAILY',true);
  const evidence = await read('2026-09-01','2026-09-01');
  expect(evidence).toHaveLength(1);
  expect(evidence[0]).toMatchObject({ status: 'measured', rowCount: 1 });
  expect(evidence.flatMap((item) => item.rows).reduce((sum,row) => sum + (row.metrics['cost'] ?? 0),0)).toBe(7);
});
it.each([
  { name: 'narrower', intervals: [['2026-09-03','2026-09-05']] },
  { name: 'disjoint', intervals: [['2026-08-20','2026-08-25']] },
  { name: 'overlapping', intervals: [['2026-08-25','2026-09-05'],['2026-09-04','2026-09-15']] },
  { name: 'adjacent without an exact interval', intervals: [['2026-09-01','2026-09-05'],['2026-09-06','2026-09-10']] },
])('refuses measured SUMMARY evidence for $name windows', async ({ intervals }) => {
  for (const [start,end] of intervals) await persist(start!,end!,'SUMMARY');
  const evidence = await read();
  expect(evidence).toHaveLength(1);
  expect(evidence[0]?.status).not.toBe('measured');
  expect(evidence[0]?.rowCount).toBe(0);
});
it('measures exactly covered SUMMARY windows without adding overlapping summaries', async () => {
  await persist('2026-09-01','2026-09-10','SUMMARY');
  await persist('2026-09-03','2026-09-05','SUMMARY');
  const evidence = await read();
  expect(evidence).toHaveLength(1);
  expect(evidence[0]).toMatchObject({ status: 'measured', rowCount: 1 });
  expect(evidence[0]?.rows[0]?.metrics['cost']).toBe(7);
});
