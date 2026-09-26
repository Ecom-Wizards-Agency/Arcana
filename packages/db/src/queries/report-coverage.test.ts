import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../testing/harness.js';
import { backfillReportCoverage, recordReportCoverage, upsertReportCoverage } from './report-coverage.js';
import { readProfileFreshness } from './freshness.js';
import { coverageFor, readGridPerformance } from './grid-performance-evidence.js';
import type { ReportCoverageAccounting, ReportCoverageObservation } from '@wizard-ads/shared';

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
  await database.sql`select * from app.ensure_fact_partitions('2026-09-01'::date, 0)`;
}, 120_000);
beforeEach(async () => {
  await database.sql`delete from public.report_promotion_watermarks`;
  await database.sql`delete from public.report_coverage`;
  await database.sql`delete from public.fact_sb_daily`;
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

// WP-324: the Ads report lifecycle records the days a reconciled load returned.
interface Request { id: string; requestedAt: string }
async function completedRequest(reportType: string, start: string, end: string, options: {
  requestedAt?: string; completedAt?: string; parsed?: number; loaded?: number;
} = {}): Promise<Request> {
  const requestedAt = options.requestedAt ?? `${end}T02:00:00.000Z`;
  const [row] = await database.sql<{ id: string }[]>`
    insert into public.report_requests
      (org_id, profile_id, report_type, start_date, end_date, status, requested_at, completed_at, rows_parsed, rows_loaded)
    values (${orgId}, ${profileId}, ${reportType}, ${start}, ${end}, 'completed', ${requestedAt},
            ${options.completedAt ?? `${end}T03:00:00.000Z`}, ${options.parsed ?? 0}, ${options.loaded ?? options.parsed ?? 0})
    returning id
  `;
  return { id: row!.id, requestedAt };
}
/** Sponsored Products promotion writes one watermark per report day, empty days included. */
async function promotedDays(request: Request, reportType: string, days: readonly string[]) {
  for (const day of days) {
    await database.sql`
      insert into public.report_promotion_watermarks
        (org_id, profile_id, report_type, report_date, source, report_request_id, requested_at,
         source_rows, parsed_rows, refused_rows, promoted_rows, canonical_rows)
      values (${orgId}, ${profileId}, ${reportType}, ${day}, 'amazon_reporting_v3', ${request.id},
              ${request.requestedAt}, 1, 1, 0, 1, 1)
    `;
  }
}
async function sbFacts(request: Request, days: readonly string[]) {
  for (const day of days) {
    await database.sql`
      insert into public.fact_sb_daily (org_id, profile_id, date, campaign_id, ad_group_id, cost, report_request_id)
      values (${orgId}, ${profileId}, ${day}, 'synthetic-sb-campaign', 'synthetic-sb-group', 1, ${request.id})
    `;
  }
}
function accounting(rows: number, observedAt: string): ReportCoverageAccounting {
  return { sourceRows: rows, parsedRows: rows, refusedRows: 0, observedAt, settledThrough: null };
}
async function span(reportType: string) {
  const rows = await database.sql<{
    earliest_returned_date: string | null; latest_loaded_date: string | null; missing_dates: string[];
    observed_at: Date | string; loaded_rows: string | null;
  }[]>`
    select earliest_returned_date::text, latest_loaded_date::text, missing_dates::text[], observed_at, loaded_rows
      from public.report_coverage where profile_id = ${profileId} and report_type = ${reportType}
  `;
  expect(rows).toHaveLength(1);
  return { ...rows[0]!, observed_at: new Date(rows[0]!.observed_at).toISOString() };
}
const coverageRows = () => database.sql<{
  report_type: string; earliest_returned_date: string | null; latest_loaded_date: string | null;
  availability_start_date: string | null; missing_dates: string[]; status: string; counts_match: boolean | null;
}[]>`
  select report_type, earliest_returned_date::text, latest_loaded_date::text, availability_start_date::text,
         missing_dates::text[], status::text, counts_match
    from public.report_coverage where profile_id = ${profileId}
`;

it('grows the verified span by the union of loaded windows and leaves gaps between requests unclaimed', async () => {
  const first = await completedRequest('spTargeting', '2026-09-01', '2026-09-03', { parsed: 3 });
  await promotedDays(first, 'spTargeting', ['2026-09-01', '2026-09-02', '2026-09-03']);
  const second = await completedRequest('spTargeting', '2026-09-06', '2026-09-07', { parsed: 2 });
  await promotedDays(second, 'spTargeting', ['2026-09-06', '2026-09-07']);
  expect(await recordReportCoverage(database, first.id, accounting(3, '2026-09-04T03:00:00.000Z')))
    .toEqual({ offered: 1, written: 1, unchanged: 0 });
  expect(await span('spTargeting')).toMatchObject({
    earliest_returned_date: '2026-09-01', latest_loaded_date: '2026-09-03', missing_dates: [],
  });
  expect(await recordReportCoverage(database, second.id, accounting(2, '2026-09-08T03:00:00.000Z')))
    .toEqual({ offered: 1, written: 1, unchanged: 0 });
  expect(await span('spTargeting')).toMatchObject({
    earliest_returned_date: '2026-09-01', latest_loaded_date: '2026-09-07',
    missing_dates: ['2026-09-04', '2026-09-05'],
  });
  expect(coverageFor('PPC', await coverageRows(), '2026-09-01', '2026-09-07')).toEqual({
    feed: 'PPC', daysHeld: 5, daysRequested: 7, notScraped: 2, status: 'partial',
    reason: '2026-09-01 – 2026-09-07 · 5 of 7 days held',
  });

  const gap = await completedRequest('spTargeting', '2026-09-04', '2026-09-05',
    { parsed: 2, requestedAt: '2026-09-09T02:00:00.000Z', completedAt: '2026-09-09T03:00:00.000Z' });
  await promotedDays(gap, 'spTargeting', ['2026-09-04', '2026-09-05']);
  // An older window never replaces the newer observation, but its days still join the span.
  expect(await recordReportCoverage(database, gap.id, accounting(2, '2026-09-09T03:00:00.000Z')))
    .toEqual({ offered: 1, written: 0, unchanged: 1 });
  expect(await span('spTargeting')).toMatchObject({
    earliest_returned_date: '2026-09-01', latest_loaded_date: '2026-09-07', missing_dates: [], loaded_rows: '2',
    observed_at: '2026-09-08T03:00:00.000Z',
  });
  const grid = await readGridPerformance(database, orgId, profileId, '2026-09-01', '2026-09-07');
  expect(grid.feeds.find((feed) => feed.feed === 'PPC')).toMatchObject({ status: 'complete', daysHeld: 7, daysRequested: 7 });
});

it('claims only the days a sparse report returned rows for, never its requested range', async () => {
  const request = await completedRequest('sbCampaigns', '2026-09-01', '2026-09-05', { parsed: 2 });
  await sbFacts(request, ['2026-09-02', '2026-09-04']);
  await recordReportCoverage(database, request.id, accounting(2, '2026-09-06T03:00:00.000Z'));
  expect(await span('sbCampaigns')).toMatchObject({
    earliest_returned_date: '2026-09-02', latest_loaded_date: '2026-09-05',
    missing_dates: ['2026-09-03', '2026-09-05'],
  });
  // A later range that returned nothing leaves every one of its days unclaimed.
  const empty = await completedRequest('sbCampaigns', '2026-09-06', '2026-09-08');
  await recordReportCoverage(database, empty.id, accounting(0, '2026-09-09T03:00:00.000Z'));
  expect(await span('sbCampaigns')).toMatchObject({
    earliest_returned_date: '2026-09-02', latest_loaded_date: '2026-09-08',
    missing_dates: ['2026-09-03', '2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08'],
  });
  const { entries } = await readProfileFreshness(database, { orgId, userId }, profileId);
  expect(entries[0]).toMatchObject({
    coveredThrough: '2026-09-08',
    verified: { from: '2026-09-02', through: '2026-09-04', daysHeld: 2, gapDays: 1 },
  });
});

it('is idempotent: replaying a completion changes no stored byte', async () => {
  const request = await completedRequest('spTargeting', '2026-09-01', '2026-09-02', { parsed: 2 });
  await promotedDays(request, 'spTargeting', ['2026-09-01', '2026-09-02']);
  await recordReportCoverage(database, request.id, accounting(2, '2026-09-03T03:00:00.000Z'));
  const before = await database.sql`select * from public.report_coverage`;
  expect(await recordReportCoverage(database, request.id, accounting(2, '2026-09-03T03:00:00.000Z')))
    .toEqual({ offered: 1, written: 0, unchanged: 1 });
  expect(await database.sql`select * from public.report_coverage`).toEqual(before);
  expect(before).toHaveLength(1);
});

it('never claims a day for a load whose counts do not reconcile', async () => {
  const lossy = await completedRequest('sbCampaigns', '2026-09-01', '2026-09-02', { parsed: 3, loaded: 2 });
  await sbFacts(lossy, ['2026-09-01', '2026-09-02']);
  expect(await database.sql`select day from app.report_request_loaded_days(${lossy.id}) as loaded(day)`).toHaveLength(0);
  await recordReportCoverage(database, lossy.id);
  expect(await span('sbCampaigns')).toMatchObject({ earliest_returned_date: null, missing_dates: [] });
  expect(coverageFor('PPC', (await coverageRows()).map((row) => ({ ...row, report_type: 'spTargeting' })), '2026-09-01', '2026-09-02'))
    .toMatchObject({ status: 'not-measured', daysHeld: 0 });
  const failed = await completedRequest('sbCampaigns', '2026-09-03', '2026-09-03', { parsed: 1 });
  await database.sql`update public.report_requests set status = 'failed' where id = ${failed.id}`;
  await sbFacts(failed, ['2026-09-03']);
  expect(await database.sql`select day from app.report_request_loaded_days(${failed.id}) as loaded(day)`).toHaveLength(0);
});

it('lets a superseded request claim the days it still owns without refreshing the newer observation', async () => {
  const older = await completedRequest('spTargeting', '2026-09-01', '2026-09-03',
    { parsed: 1, requestedAt: '2026-09-04T01:00:00.000Z', completedAt: '2026-09-04T09:00:00.000Z' });
  const newer = await completedRequest('spTargeting', '2026-09-02', '2026-09-03',
    { parsed: 2, requestedAt: '2026-09-04T02:00:00.000Z', completedAt: '2026-09-04T03:00:00.000Z' });
  await promotedDays(newer, 'spTargeting', ['2026-09-02', '2026-09-03']);
  await promotedDays(older, 'spTargeting', ['2026-09-01']);
  // No row yet: the superseded request offers its observation once, then claims.
  expect(await recordReportCoverage(database, older.id, null)).toEqual({ offered: 1, written: 1, unchanged: 0 });
  expect(await span('spTargeting')).toMatchObject({
    earliest_returned_date: '2026-09-01', latest_loaded_date: '2026-09-03', missing_dates: ['2026-09-02', '2026-09-03'],
  });
  await database.sql`delete from public.report_coverage`;
  await recordReportCoverage(database, newer.id, accounting(2, '2026-09-04T03:00:00.000Z'));
  expect(await recordReportCoverage(database, older.id, null)).toEqual({ offered: 0, written: 0, unchanged: 0 });
  expect(await span('spTargeting')).toMatchObject({
    earliest_returned_date: '2026-09-01', latest_loaded_date: '2026-09-03', missing_dates: [],
    loaded_rows: '2', observed_at: '2026-09-04T03:00:00.000Z',
  });
});

it('refuses to claim the days of a request from another report scope', async () => {
  const request = await completedRequest('sbCampaigns', '2026-09-01', '2026-09-01', { parsed: 1 });
  await expect(upsertReportCoverage(database, {
    orgId, profileId, source: 'amazon_reporting_v3', reportType: 'spTargeting', grain: 'sp_target',
    status: 'complete', earliestDate: '2026-09-01', coveredThrough: '2026-09-01', settledThrough: null,
    observedAt: '2026-09-02T03:00:00.000Z', sourceRows: 1, parsedRows: 1, loadedRows: 1, refusedRows: 0, countsMatch: true,
  }, 1, { loadedBy: request.id })).rejects.toThrow('another report request scope');
  expect(await database.sql`select id from public.report_coverage`).toHaveLength(0);
});
