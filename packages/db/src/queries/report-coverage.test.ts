import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../testing/harness.js';
import { backfillReportCoverage, recordReportCoverage, upsertReportCoverage } from './report-coverage.js';
import { readProfileFreshness } from './freshness.js';
import type { ReportCoverageObservation } from '@wizard-ads/shared';

const userId = '00000000-0000-4000-8000-000000000256';
let database: TestDatabase;
let orgId: string;
let profileId: string;
beforeAll(async () => {
  database = await createTestDatabase('coverage_producer');
  const [org] = await database.sql<{ id: string }[]>`
    select app.seed_tenant_fixture('coverage-alpha', ${userId}::uuid) as id
  `;
  orgId = org!.id;
  const [profile] = await database.sql<{ id: string }[]>`
    select id from public.ad_profiles where org_id = ${orgId} limit 1
  `;
  profileId = profile!.id;
}, 120_000);
beforeEach(async () => {
  await database.sql`delete from public.report_promotion_watermarks`;
  await database.sql`delete from public.report_coverage`;
  await database.sql`delete from public.report_requests`;
});
afterAll(async () => { await database?.drop(); });

function observation(overrides: Partial<ReportCoverageObservation> = {}): ReportCoverageObservation {
  return {
    orgId, profileId, source: 'selling_partner_api', reportType: 'sales_and_traffic', grain: 'asin',
    status: 'complete', earliestDate: '2026-08-10', coveredThrough: '2026-08-12',
    settledThrough: null, observedAt: '2026-08-14T08:00:00.000Z',
    sourceRows: 8, parsedRows: 8, loadedRows: 4, refusedRows: 0, countsMatch: true,
    ...overrides,
  };
}

it('writes exactly one non-Ads observation and reads its actual counts', async () => {
  expect(await upsertReportCoverage(database, observation(), 4)).toEqual({ offered: 1, written: 1, unchanged: 0 });
  const result = await readProfileFreshness(database, { orgId, userId }, profileId);
  expect(result.answeredBy).toBe('coverage');
  expect(result.entries).toHaveLength(1);
  expect(result.entries[0]).toMatchObject({ sourceRows: 8, parsedRows: 8, loadedRows: 4, refusedRows: 0 });
  expect(await upsertReportCoverage(database, observation(), 4)).toEqual({ offered: 1, written: 0, unchanged: 1 });
  await expect(upsertReportCoverage(database, observation(), 3)).rejects.toThrow('verified load');
  await expect(upsertReportCoverage(database, observation({ loadedRows: 3 }), 3)).rejects.toThrow('conflicting coverage');
  const [count] = await database.sql<{ count: number }[]>`select count(*)::int as count from public.report_coverage`;
  expect(count!.count).toBe(1);
});

it('does not let older ranges or stale observations replace current coverage', async () => {
  await upsertReportCoverage(database, observation(), 4);
  expect(await upsertReportCoverage(database, observation({
    coveredThrough: '2026-08-11', observedAt: '2026-08-15T08:00:00.000Z',
  }), 4)).toMatchObject({ written: 0, unchanged: 1 });
  expect(await upsertReportCoverage(database, observation({ observedAt: '2026-08-13T08:00:00.000Z' }), 4))
    .toMatchObject({ written: 0, unchanged: 1 });
  expect(await upsertReportCoverage(database, observation({
    coveredThrough: '2026-08-13', observedAt: '2026-08-13T08:00:00.000Z',
  }), 4)).toMatchObject({ written: 1, unchanged: 0 });
});

it('backfills one row per successful ledger group and a second run changes nothing', async () => {
  await database.sql`
    insert into public.report_requests
      (org_id, profile_id, report_type, start_date, end_date, status, requested_at, completed_at,
       source_rows, rows_parsed, rows_loaded, refused_rows, promoted_rows, unpromoted_rows)
    values
      (${orgId}, ${profileId}, 'spTargeting', '2026-08-10', '2026-08-12', 'completed',
       '2026-08-14T02:00:00Z', '2026-08-14T03:00:00Z', 8, 8, 8, 0, 8, 0),
      (${orgId}, ${profileId}, 'spTargeting', '2026-08-01', '2026-08-02', 'completed',
       '2026-08-15T02:00:00Z', '2026-08-15T03:00:00Z', 2, 2, 2, 0, 2, 0),
      (${orgId}, ${profileId}, 'spCampaigns', '2026-08-10', '2026-08-12', 'completed',
       '2026-08-14T02:00:00Z', '2026-08-14T03:00:00Z', 0, 0, 0, 0, 0, 0),
      (${orgId}, ${profileId}, 'spSearchTerm', '2026-08-10', '2026-08-12', 'failed',
       '2026-08-14T02:00:00Z', '2026-08-14T03:00:00Z', null, null, null, null, null, null)
  `;
  expect(await backfillReportCoverage(database)).toEqual({ groups: 2, written: 2, unchanged: 0 });
  const snapshot = await database.sql`select * from public.report_coverage order by report_type`;
  expect(snapshot).toHaveLength(2);
  expect(snapshot[0]).toMatchObject({ source_rows: '0', parsed_rows: '0', loaded_rows: '0', refused_rows: '0' });
  expect(snapshot[1]).toMatchObject({ source_rows: '8', parsed_rows: '8', loaded_rows: '8', refused_rows: '0' });
  expect(await backfillReportCoverage(database)).toEqual({ groups: 2, written: 0, unchanged: 2 });
  expect(await database.sql`select * from public.report_coverage order by report_type`).toEqual(snapshot);
});

it('publishes counted zero-row range coverage without inventing returned dates', async () => {
  const [report] = await database.sql<{ id: string }[]>`
    insert into public.report_requests
      (org_id, profile_id, report_type, start_date, end_date, status, completed_at, rows_parsed, rows_loaded)
    values (${orgId}, ${profileId}, 'spTargeting', '2026-08-10', '2026-08-12', 'completed',
            '2026-08-14T03:00:00Z', 0, 0) returning id
  `;
  expect(await recordReportCoverage(database, report!.id, {
    sourceRows: 0, parsedRows: 0, refusedRows: 0,
    observedAt: '2026-08-14T03:00:00.000Z', settledThrough: null,
  })).toEqual({ offered: 1, written: 1, unchanged: 0 });
  const [row] = await database.sql`select * from public.report_coverage`;
  expect(row).toMatchObject({ earliest_returned_date: null, source_rows: '0', loaded_rows: '0' });
});

it('preserves unknown legacy source accounting while retaining recorded load counts', async () => {
  await database.sql`
    insert into public.report_requests
      (org_id, profile_id, report_type, start_date, end_date, status, completed_at, rows_parsed, rows_loaded)
    values (${orgId}, ${profileId}, 'spCampaigns', '2026-08-10', '2026-08-12', 'completed',
            '2026-08-14T03:00:00Z', 2, 2)
  `;
  expect(await backfillReportCoverage(database)).toEqual({ groups: 1, written: 1, unchanged: 0 });
  const { entries } = await readProfileFreshness(database, { orgId, userId }, profileId);
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ sourceRows: null, refusedRows: null, parsedRows: 2, loadedRows: 2 });
});

it('keeps imported and Amazon ledger groups separate and falls back by source', async () => {
  await database.sql`
    insert into public.report_requests
      (org_id, profile_id, report_type, source, start_date, end_date, status, completed_at, rows_parsed, rows_loaded)
    values (${orgId}, ${profileId}, 'spCampaigns', 'amazon_api', '2026-08-10', '2026-08-12', 'completed',
            '2026-08-14T03:00:00Z', 2, 2),
           (${orgId}, ${profileId}, 'spCampaigns', 'adlabs_backfill', '2026-08-10', '2026-08-12', 'completed',
            '2026-08-14T03:00:00Z', 3, 3)
  `;
  expect(await backfillReportCoverage(database)).toEqual({ groups: 2, written: 2, unchanged: 0 });
  const read = () => readProfileFreshness(database, { orgId, userId }, profileId);
  const covered = await read();
  expect(covered.answeredBy).toBe('coverage');
  expect(covered.entries).toHaveLength(2);
  expect(covered.entries.find((row) => row.source === 'secondary_import')).toMatchObject({ loadedRows: 3 });
  await database.sql`delete from public.report_coverage where source = 'amazon_reporting_v3'`;
  const mixed = await read();
  expect(mixed.answeredBy).toBe('mixed');
  expect(mixed.entries).toHaveLength(2);
  expect(mixed.entries.find((row) => row.source === 'amazon_reporting_v3')).toMatchObject({ rowsLoaded: 2 });
});

it('does not backfill a superseded zero-row completion over newer promoted evidence', async () => {
  const requests = await database.sql<{ id: string; rows_loaded: string }[]>`
    insert into public.report_requests
      (org_id, profile_id, report_type, start_date, end_date, status, requested_at, completed_at, rows_parsed, rows_loaded)
    values (${orgId}, ${profileId}, 'spTargeting', '2026-08-10', '2026-08-12', 'completed',
            '2026-08-13T03:00:00Z', '2026-08-15T03:00:00Z', 0, 0),
           (${orgId}, ${profileId}, 'spTargeting', '2026-08-10', '2026-08-12', 'completed',
            '2026-08-14T02:00:00Z', '2026-08-14T03:00:00Z', 2, 2)
    returning id, rows_loaded
  `;
  const newest = requests.find((row) => Number(row.rows_loaded) === 2)!;
  await database.sql`
    insert into public.report_promotion_watermarks
      (org_id, profile_id, report_type, report_date, source, report_request_id, requested_at,
       source_rows, parsed_rows, refused_rows, promoted_rows, canonical_rows)
    values (${orgId}, ${profileId}, 'spTargeting', '2026-08-12', 'amazon_reporting_v3', ${newest.id},
            '2026-08-14T02:00:00Z', 2, 2, 0, 2, 2)
  `;
  expect(await backfillReportCoverage(database)).toEqual({ groups: 1, written: 1, unchanged: 0 });
  const { entries } = await readProfileFreshness(database, { orgId, userId }, profileId);
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ loadedRows: 2, observedAt: '2026-08-14T03:00:00.000Z' });
});

it('refuses budget accounting replacement for unrelated sources or missing run identity', async () => {
  await expect(upsertReportCoverage(database, observation(), 4, { accounting: 'verified_budget_run' })).rejects.toThrow('scoped budget source run');
  await expect(upsertReportCoverage(database, observation({ source: 'amazon_ads_api', reportType: 'campaign_budget_usage', grain: 'campaign_budget_usage' }), 4, { accounting: 'verified_budget_run' })).rejects.toThrow('scoped budget source run');
  expect(await database.sql`select id from public.report_coverage`).toHaveLength(0);
});
