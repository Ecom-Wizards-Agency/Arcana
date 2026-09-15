import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@wizard-ads/db/testing';
import { readCoreReportEvidence } from '@wizard-ads/db';
import { defaultCoreReportConfiguration, parseCoreReport } from '@wizard-ads/ads-api';
import { CoreFeatureReportType, type CoreReportPromotion } from '@wizard-ads/shared';
import { PostgresWorkerStore } from './store.js';

let db: TestDatabase;
let store: PostgresWorkerStore;
let orgId: string;
let profileId: string;
beforeAll(async () => {
  db = await createTestDatabase('wp310_completion');
  const [org] = await db.sql`select app.seed_tenant_fixture('synthetic-completion',${randomUUID()},'owner') as id`;
  orgId = org!['id'] as string;
  const [profile] = await db.sql`select id from public.ad_profiles where org_id=${orgId} limit 1`;
  profileId = profile!['id'] as string;
  store = new PostgresWorkerStore(db);
}, 120000);
afterAll(async () => { await db?.drop(); });
async function report(requestedAt: string, rows: unknown[]): Promise<CoreReportPromotion> {
  const configuration = defaultCoreReportConfiguration('spAdvertisedProduct');
  const id = randomUUID();
  await db.sql`insert into public.report_requests(id,org_id,profile_id,report_type,start_date,end_date,requested_at,family_configuration) values(${id},${orgId},${profileId},'spAdvertisedProduct','2026-09-01','2026-09-01',${requestedAt},${JSON.stringify(configuration)}::jsonb)`;
  return { orgId, profileId, reportRequestId: id, requestedAt, observedAt: requestedAt, startDate: '2026-09-01', endDate: '2026-09-01', parsed: parseCoreReport(configuration, rows, '2026-09-01', '2026-09-01') };
}
const raw = { date: '2026-09-01', campaignId: 'synthetic-c', adGroupId: 'synthetic-g', advertisedAsin: 'B000000001', adId: 'synthetic-a', cost: 3 };
async function finish(p: CoreReportPromotion) {
  const loaded = p.parsed.refusals.length ? 0 : p.parsed.rows.length;
  return store.finishAttributedReport(p.reportRequestId, { sourceRows: p.parsed.sourceRows, parsedRows: p.parsed.parsedRows, refusedRows: p.parsed.refusals.length, promotedRows: loaded, canonicalRows: loaded, unpromotedRows: p.parsed.parsedRows - loaded }, { status: p.parsed.refusals.length ? 'failed' : 'completed', bytesDownloaded: 100, promotion: p, coverage: { sourceRows: p.parsed.sourceRows, parsedRows: p.parsed.parsedRows, refusedRows: p.parsed.refusals.length, observedAt: p.observedAt, settledThrough: null } });
}
it('commits verified facts, ledger and coverage together and preserves the replay observation', async () => {
  const p = await report('2026-09-03T00:00:00.000Z', [raw, raw]);
  await finish(p);
  const [ledger] = await db.sql`select status,source_rows,rows_parsed,promoted_rows,unpromoted_rows,rows_loaded,accounting_complete from public.report_requests where id=${p.reportRequestId}`;
  expect(ledger?.['status']).toBe('completed');
  expect([ledger?.['source_rows'],ledger?.['rows_parsed'],ledger?.['promoted_rows'],ledger?.['unpromoted_rows'],ledger?.['rows_loaded']].map(Number)).toEqual([2,2,1,1,1]);
  expect(ledger?.['accounting_complete']).toBe(true);
  await finish({ ...p, observedAt: '2026-09-04T00:00:00.000Z' });
  const evidence = await readCoreReportEvidence(db, { orgId, profileId, families: ['spAdvertisedProduct'], startDate: p.startDate, endDate: p.endDate });
  expect(evidence[0]).toMatchObject({ status: 'measured', rowCount: 1, observedAt: p.observedAt });
});
it('keeps a stale attempt counted without replacing facts or refreshing coverage', async () => {
  const p = await report('2026-09-02T00:00:00.000Z', [{ ...raw, cost: 99 }]);
  await expect(finish(p)).rejects.toThrow('superseded');
  const [attempt] = await db.sql`select staged_rows,promoted_rows,verified_rows from public.report_family_attempts where report_request_id=${p.reportRequestId}`;
  expect([attempt?.['staged_rows'],attempt?.['promoted_rows'],attempt?.['verified_rows']].map(Number)).toEqual([1,0,0]);
  const [ledger] = await db.sql`select status,rows_loaded,unpromoted_rows,accounting_complete from public.report_requests where id=${p.reportRequestId}`;
  expect(ledger).toMatchObject({ status: 'failed', accounting_complete: true });
  expect(Number(ledger?.['rows_loaded'])).toBe(0);
});
it('persists refusal reasons while leaving prior facts visible as partial evidence', async () => {
  const p = await report('2026-09-05T00:00:00.000Z', [raw, null]);
  await finish(p);
  const evidence = await readCoreReportEvidence(db, { orgId, profileId, families: ['spAdvertisedProduct'], startDate: p.startDate, endDate: p.endDate });
  expect(evidence[0]).toMatchObject({ status: 'partial', rowCount: 1, observedAt: '2026-09-03T00:00:00.000Z' });
});
it('persists no schedules or jobs for absent capabilities', async () => {
  expect(await store.provisionCoreFamilySchedules(orgId, profileId)).toEqual({ offered: 0, written: 0, existing: 0 });
  const rows = await db.sql`select id from public.sync_schedules where org_id=${orgId} and profile_id=${profileId} and report_type::text=any(${CoreFeatureReportType.options})`;
  expect(rows).toHaveLength(0);
  await db.sql`select * from public.enqueue_due_schedules(now())`;
  const jobs = await db.sql`select id from public.sync_jobs where org_id=${orgId} and profile_id=${profileId} and job_type='report.request' and payload->>'reportType'=any(${CoreFeatureReportType.options})`;
  expect(jobs).toHaveLength(0);
  expect(await store.coreReportCapability(orgId, profileId, 'spAdvertisedProduct')).toBeNull();
});
it('persists no schedules or jobs for explicitly disabled capabilities', async () => {
  await db.sql`insert into public.report_family_capabilities(org_id,profile_id,family,marketplace,enabled) values(${orgId},${profileId},'spAdvertisedProduct','synthetic',false)`;
  expect(await store.provisionCoreFamilySchedules(orgId, profileId)).toEqual({ offered: 0, written: 0, existing: 0 });
  expect(await db.sql`select id from public.sync_schedules where org_id=${orgId} and profile_id=${profileId} and report_type::text=any(${CoreFeatureReportType.options})`).toHaveLength(0);
  await db.sql`select * from public.enqueue_due_schedules(now())`;
  expect(await db.sql`select id from public.sync_jobs where org_id=${orgId} and profile_id=${profileId} and payload->>'reportType'=any(${CoreFeatureReportType.options})`).toHaveLength(0);
});
it('provisions only an opted-in family and independently verifies its three disabled schedules', async () => {
  await db.sql`update public.report_family_capabilities set enabled=true,status='eligible',recovery_gate_evidence='synthetic-recovery',observed_at='2026-09-01T00:00:00Z' where org_id=${orgId} and profile_id=${profileId} and family='spAdvertisedProduct'`;
  expect(await store.provisionCoreFamilySchedules(orgId, profileId)).toEqual({ offered: 3, written: 3, existing: 0 });
  expect(await store.provisionCoreFamilySchedules(orgId, profileId)).toEqual({ offered: 3, written: 0, existing: 3 });
  const rows = await db.sql`select report_type::text,enabled from public.sync_schedules where org_id=${orgId} and profile_id=${profileId} and report_type::text=any(${CoreFeatureReportType.options})`;
  expect(rows).toHaveLength(3);
  expect(rows.every((row) => row['report_type'] === 'spAdvertisedProduct' && row['enabled'] === false)).toBe(true);
});
it('rolls back staged facts and coverage when the final ledger update fails', async () => {
  const p = await report('2026-09-06T00:00:00.000Z', [{ ...raw, cost: 999 }]);
  await db.sql.unsafe("create function public.wp310_refuse_completion() returns trigger language plpgsql as $$ begin raise exception 'synthetic completion failure'; end $$");
  await db.sql.unsafe('create trigger wp310_refuse_completion before update on public.report_requests for each row execute function public.wp310_refuse_completion()');
  try {
    await expect(finish(p)).rejects.toThrow('synthetic completion failure');
    const [fact] = await db.sql`select row_data->'metrics'->>'cost' as cost from public.fact_advertised_product_daily where org_id=${orgId} and profile_id=${profileId} and family='spAdvertisedProduct'`;
    expect(Number(fact?.['cost'])).toBe(3);
    expect(await db.sql`select * from public.report_family_attempts where report_request_id=${p.reportRequestId}`).toHaveLength(0);
    const [coverage] = await db.sql`select observed_at from public.report_coverage where org_id=${orgId} and profile_id=${profileId} and report_type='spAdvertisedProduct'`;
    expect(new Date(coverage?.['observed_at'] as string).toISOString()).toBe('2026-09-03T00:00:00.000Z');
  } finally {
    await db.sql.unsafe('drop trigger wp310_refuse_completion on public.report_requests');
    await db.sql.unsafe('drop function public.wp310_refuse_completion()');
  }
});
it('records a complete empty replacement as observed zero rows, distinct from missing evidence', async () => {
  const p = await report('2026-09-07T00:00:00.000Z', []);
  await finish(p);
  const evidence = await readCoreReportEvidence(db, { orgId, profileId, families: ['spAdvertisedProduct'], startDate: p.startDate, endDate: p.endDate });
  expect(evidence[0]).toMatchObject({ status: 'measured', rowCount: 0, observedAt: p.observedAt });
  const [attempt] = await db.sql`select source_rows,parsed_rows,staged_rows,promoted_rows,verified_rows from public.report_family_attempts where report_request_id=${p.reportRequestId}`;
  expect(Object.values(attempt ?? {}).map(Number)).toEqual([0,0,0,0,0]);
});
it('does not tombstone an unlisted SP campaign negative target while its family is disabled', async () => {
  await db.sql`insert into public.negatives(org_id,profile_id,amazon_id,ad_product,campaign_id,scope,keyword_text,expression,state,match_type) values(${orgId},${profileId},'synthetic-campaign-negative','SP','c-1','campaign',null,'[{"type":"asin_same_as","value":"B000000099"}]'::jsonb,'enabled','negative_exact')`;
  const profile = { id: profileId, orgId, amazonProfileId: 'synthetic', region: 'NA' as const, currencyCode: 'USD', timezone: 'UTC' };
  await store.syncEntities(profile, [], { adProduct: 'SP', full: true, readStartedAt: new Date().toISOString(), preserveCampaignNegativeTargets: true, excludedEntityTypes: ['portfolio','campaign','ad_group','product_ad','keyword','target'] });
  const [row] = await db.sql`select deleted_at from public.negatives where org_id=${orgId} and profile_id=${profileId} and amazon_id='synthetic-campaign-negative'`;
  expect(row).toBeDefined();
  expect(row?.['deleted_at']).toBeNull();
});
