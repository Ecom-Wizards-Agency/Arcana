/**
 * WP-324 backfill: the migration claims, once, every day completed and reconciled
 * Amazon Ads requests already loaded, from their own evidence, and yields the
 * same verified spans the worker producer records for the same history.
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { applySqlFile, createTestDatabase, type TestDatabase } from '../testing/harness.js';
import { backfillReportCoverage, recordReportCoverage, upsertReportCoverage } from './report-coverage.js';

const BEFORE = '20260915350000_provider_recommendation_evidence.sql';
const MIGRATION = fileURLToPath(new URL(
  '../../../../supabase/migrations/20260916200000_report_coverage_verified_days.sql', import.meta.url,
));
const CORE_GRAIN = 'advertised_product:DAILY:legacy:v1';

interface Tenant { orgId: string; profileId: string }
interface History { ordered: Array<{ id: string; reportType: string; completedAt: string; loaded: number }> }
let database: TestDatabase;
let history: Tenant;
let produced: Tenant;
let seeded: History;

async function tenant(slug: string): Promise<Tenant> {
  const [org] = await database.sql<{ id: string }[]>`
    select app.seed_tenant_fixture(${slug}, ${randomUUID()}::uuid) as id
  `;
  const [profile] = await database.sql<{ id: string }[]>`
    select id from public.ad_profiles where org_id = ${org!.id} limit 1
  `;
  const scope = { orgId: org!.id, profileId: profile!.id };
  // The fixture's own ledger and coverage rows are not this history.
  for (const table of ['report_promotion_watermarks', 'report_coverage', 'fact_profile_daily',
    'fact_sp_target_daily', 'fact_sb_daily', 'fact_sd_daily']) {
    await database.sql`delete from ${database.sql(`public.${table}`)} where profile_id = ${scope.profileId}`;
  }
  await database.sql`delete from public.report_requests where profile_id = ${scope.profileId}`;
  return scope;
}

async function seedHistory({ orgId, profileId }: Tenant): Promise<History> {
  const ordered: History['ordered'] = [];
  const request = async (reportType: string, start: string, end: string, completedAt: string, options: {
    parsed?: number; loaded?: number; status?: string; source?: string; snapshot?: string;
    attributed?: boolean;
  } = {}) => {
    const parsed = options.parsed ?? 0;
    const loaded = options.loaded ?? parsed;
    const attributed = options.attributed === true;
    const [row] = await database.sql<{ id: string }[]>`
      insert into public.report_requests
        (org_id, profile_id, report_type, source, start_date, end_date, status, requested_at, completed_at,
         rows_parsed, rows_loaded, creative_sync_snapshot_id,
         source_rows, refused_rows, promoted_rows, unpromoted_rows)
      values (${orgId}, ${profileId}, ${reportType}, ${options.source ?? 'amazon_api'}, ${start}, ${end},
              ${options.status ?? 'completed'}, ${new Date(Date.parse(completedAt) - 3_600_000).toISOString()},
              ${completedAt}, ${parsed}, ${loaded}, ${options.snapshot ?? null},
              ${attributed ? parsed : null}, ${attributed ? 0 : null}, ${attributed ? loaded : null},
              ${attributed ? parsed - loaded : null})
      returning id
    `;
    return row!.id;
  };
  const watermark = async (id: string, reportType: string, day: string, rows: number) => database.sql`
    insert into public.report_promotion_watermarks
      (org_id, profile_id, report_type, report_date, source, report_request_id, requested_at,
       source_rows, parsed_rows, refused_rows, promoted_rows, canonical_rows)
    select ${orgId}, ${profileId}, ${reportType}, ${day}, 'amazon_reporting_v3', ${id}, requested_at,
           ${rows}, ${rows}, 0, ${rows}, ${rows}
      from public.report_requests where id = ${id}
  `;
  const target = async (id: string, day: string, targetId: string) => database.sql`
    insert into public.fact_sp_target_daily
      (org_id, profile_id, date, ad_product, campaign_id, ad_group_id, target_id, target_kind, cost, report_request_id)
    values (${orgId}, ${profileId}, ${day}, 'SP', 'synthetic-c', 'synthetic-g', ${targetId}, 'keyword', 1, ${id})
  `;
  const campaignFact = async (table: 'fact_sb_daily' | 'fact_sd_daily', id: string, day: string) => database.sql`
    insert into ${database.sql(`public.${table}`)} (org_id, profile_id, date, campaign_id, ad_group_id, cost, report_request_id)
    values (${orgId}, ${profileId}, ${day}, 'synthetic-campaign', 'synthetic-group', 1, ${id})
  `;

  // A legacy SP load before per-day promotion: fact rows are its only evidence.
  const legacy = await request('spTargeting', '2026-08-30', '2026-08-31', '2026-09-01T03:00:00.000Z', { parsed: 2 });
  await target(legacy, '2026-08-30', 'synthetic-k1');
  await target(legacy, '2026-08-31', 'synthetic-k1');
  ordered.push({ id: legacy, reportType: 'spTargeting', completedAt: '2026-09-01T03:00:00.000Z', loaded: 2 });
  // Promoted SP windows with a two-day gap between them; 09-02 returned no row.
  const first = await request('spTargeting', '2026-09-01', '2026-09-03', '2026-09-04T03:00:00.000Z', { parsed: 2 });
  for (const [day, rows] of [['2026-09-01', 1], ['2026-09-02', 0], ['2026-09-03', 1]] as const) {
    await watermark(first, 'spTargeting', day, rows);
    if (rows > 0) await target(first, day, 'synthetic-k2');
  }
  ordered.push({ id: first, reportType: 'spTargeting', completedAt: '2026-09-04T03:00:00.000Z', loaded: 2 });
  const second = await request('spTargeting', '2026-09-06', '2026-09-07', '2026-09-08T03:00:00.000Z', { parsed: 2 });
  for (const day of ['2026-09-06', '2026-09-07']) {
    await watermark(second, 'spTargeting', day, 1);
    await target(second, day, 'synthetic-k3');
  }
  ordered.push({ id: second, reportType: 'spTargeting', completedAt: '2026-09-08T03:00:00.000Z', loaded: 2 });
  // A sparse SB window: only the days with rows are held.
  const sb = await request('sbCampaigns', '2026-09-01', '2026-09-05', '2026-09-06T03:00:00.000Z', { parsed: 2 });
  await campaignFact('fact_sb_daily', sb, '2026-09-02');
  await campaignFact('fact_sb_daily', sb, '2026-09-04');
  ordered.push({ id: sb, reportType: 'sbCampaigns', completedAt: '2026-09-06T03:00:00.000Z', loaded: 2 });
  // Core family: dense daily watermarks written in the completion transaction.
  const core = await request('spAdvertisedProduct', '2026-09-01', '2026-09-02', '2026-09-03T03:00:00.000Z',
    { parsed: 1, attributed: true });
  for (const [day, rows] of [['2026-09-01', 1], ['2026-09-02', 0]] as const) {
    await database.sql`
      insert into public.report_family_watermarks
        (org_id, profile_id, family, variant, period_start, period_end, report_request_id, requested_at, observed_at, canonical_rows)
      select ${orgId}, ${profileId}, 'spAdvertisedProduct', 'DAILY:legacy:v1', ${day}, ${day}, ${core}, requested_at,
             completed_at, ${rows}
        from public.report_requests where id = ${core}
    `;
  }
  ordered.push({ id: core, reportType: 'spAdvertisedProduct', completedAt: '2026-09-03T03:00:00.000Z', loaded: 1 });
  // A summary period holds no single day.
  const summary = await request('spAdvertisedProduct', '2026-09-04', '2026-09-05', '2026-09-06T04:00:00.000Z',
    { parsed: 0, attributed: true });
  await database.sql`
    insert into public.report_family_watermarks
      (org_id, profile_id, family, variant, period_start, period_end, report_request_id, requested_at, observed_at, canonical_rows)
    select ${orgId}, ${profileId}, 'spAdvertisedProduct', 'SUMMARY:legacy:v1', '2026-09-04', '2026-09-05', ${summary},
           requested_at, completed_at, 0
      from public.report_requests where id = ${summary}
  `;
  // SB video facts carry the request's creative snapshot rather than its id.
  const snapshot = randomUUID();
  await database.sql`
    insert into public.creative_sync_snapshots
      (id, org_id, profile_id, start_date, end_date, observed_at, mapping_provenance, historical_validity, status,
       pagination_complete, fact_promotion_allowed, source_assets, parsed_assets, source_ads, parsed_ads,
       mapped, legacy, unsupported, ambiguous, unmapped)
    values (${snapshot}, ${orgId}, ${profileId}, '2026-09-01', '2026-09-02', '2026-09-03T01:00:00.000Z',
            'current_sb_ad_snapshot', 'unproven_current_snapshot', 'completed', true, true, 0, 0, 0, 0, 0, 0, 0, 0, 0)
  `;
  const video = await request('sbAds', '2026-09-01', '2026-09-02', '2026-09-03T02:00:00.000Z',
    { parsed: 1, snapshot, attributed: true });
  await database.sql`
    insert into public.fact_creative_daily
      (org_id, profile_id, date, ad_product, campaign_id, ad_group_id, ad_id, attribution_state,
       mapping_provenance, creative_sync_snapshot_id, cost)
    values (${orgId}, ${profileId}, '2026-09-02', 'SB', 'synthetic-c', 'synthetic-g', 'synthetic-ad', 'unmapped',
            'current_sb_ad_snapshot', ${snapshot}, 1)
  `;
  ordered.push({ id: video, reportType: 'sbAds', completedAt: '2026-09-03T02:00:00.000Z', loaded: 1 });
  return { ordered };
}

/** History only the backfill sees: loads the worker never records as coverage. */
async function seedUnrecordedHistory({ orgId, profileId }: Tenant) {
  const [lossy] = await database.sql<{ id: string }[]>`
    insert into public.report_requests
      (org_id, profile_id, report_type, start_date, end_date, status, requested_at, completed_at, rows_parsed, rows_loaded)
    values (${orgId}, ${profileId}, 'sdCampaigns', '2026-09-06', '2026-09-06', 'completed',
            '2026-09-07T02:00:00Z', '2026-09-07T03:00:00Z', 2, 1)
    returning id
  `;
  const [failed] = await database.sql<{ id: string }[]>`
    insert into public.report_requests
      (org_id, profile_id, report_type, start_date, end_date, status, requested_at, completed_at, rows_parsed, rows_loaded)
    values (${orgId}, ${profileId}, 'sdCampaigns', '2026-09-01', '2026-09-01', 'failed',
            '2026-09-02T02:00:00Z', '2026-09-02T03:00:00Z', 1, 1)
    returning id
  `;
  for (const [id, day] of [[lossy!.id, '2026-09-06'], [failed!.id, '2026-09-01']] as const) {
    await database.sql`
      insert into public.fact_sd_daily (org_id, profile_id, date, campaign_id, ad_group_id, cost, report_request_id)
      values (${orgId}, ${profileId}, ${day}, 'synthetic-campaign', 'synthetic-group', 1, ${id})
    `;
  }
  // An imported profile-grain history keeps its own source.
  const [imported] = await database.sql<{ id: string }[]>`
    insert into public.report_requests
      (org_id, profile_id, report_type, source, start_date, end_date, status, requested_at, completed_at, rows_parsed, rows_loaded)
    values (${orgId}, ${profileId}, 'spCampaigns', 'adlabs_backfill', '2026-08-20', '2026-08-22', 'completed',
            '2026-08-23T02:00:00Z', '2026-08-23T03:00:00Z', 3, 3)
    returning id
  `;
  for (const day of ['2026-08-20', '2026-08-21', '2026-08-22']) {
    await database.sql`
      insert into public.fact_profile_daily (org_id, profile_id, date, currency_code, cost, provisional, report_request_id)
      values (${orgId}, ${profileId}, ${day}, 'USD', 1, false, ${imported!.id})
    `;
  }
}

const spans = (profileId: string) => database.sql<{
  report_type: string; grain: string; source: string; earliest_returned_date: string | null;
  latest_loaded_date: string | null; missing_dates: string[];
}[]>`
  select report_type, grain, source, earliest_returned_date::text, latest_loaded_date::text, missing_dates::text[]
    from public.report_coverage where profile_id = ${profileId}
   order by report_type, grain, source
`;

beforeAll(async () => {
  database = await createTestDatabase('coverage_backfill', { throughMigration: BEFORE });
  await database.sql`select * from app.ensure_fact_partitions('2026-08-01'::date, 1)`;
  history = await tenant('coverage-backfill-history');
  seeded = await seedHistory(history);
  await seedUnrecordedHistory(history);
  // As the promotion transaction wrote it before WP-324: a range without held days.
  await database.sql`
    insert into public.report_coverage
      (org_id, profile_id, report_type, grain, source, status, earliest_requested_date, latest_loaded_date,
       source_rows, parsed_rows, loaded_rows, refused_rows, counts_match, observed_at)
    values (${history.orgId}, ${history.profileId}, 'spAdvertisedProduct', ${CORE_GRAIN}, 'amazon_reporting_v3',
            'complete', '2026-09-01', '2026-09-02', 1, 1, 1, 0, true, '2026-09-03T03:00:00Z')
  `;
  await applySqlFile(database, MIGRATION);
}, 180_000);
afterAll(async () => { await database?.drop(); });

it('claims every loaded day of existing history once, at migration time', async () => {
  expect(await spans(history.profileId)).toEqual([
    { report_type: 'sbAds', grain: 'creative', source: 'amazon_reporting_v3',
      earliest_returned_date: '2026-09-02', latest_loaded_date: '2026-09-02', missing_dates: [] },
    { report_type: 'sbCampaigns', grain: 'sb', source: 'amazon_reporting_v3',
      earliest_returned_date: '2026-09-02', latest_loaded_date: '2026-09-05', missing_dates: ['2026-09-03', '2026-09-05'] },
    { report_type: 'sdCampaigns', grain: 'sd', source: 'amazon_reporting_v3',
      earliest_returned_date: null, latest_loaded_date: '2026-09-06', missing_dates: [] },
    { report_type: 'spAdvertisedProduct', grain: CORE_GRAIN, source: 'amazon_reporting_v3',
      earliest_returned_date: '2026-09-01', latest_loaded_date: '2026-09-02', missing_dates: [] },
    { report_type: 'spCampaigns', grain: 'profile', source: 'secondary_import',
      earliest_returned_date: '2026-08-20', latest_loaded_date: '2026-08-22', missing_dates: [] },
    { report_type: 'spTargeting', grain: 'sp_target', source: 'amazon_reporting_v3',
      earliest_returned_date: '2026-08-30', latest_loaded_date: '2026-09-07', missing_dates: ['2026-09-04', '2026-09-05'] },
  ]);
  const [sd] = await database.sql`select counts_match, observed_at from public.report_coverage
    where profile_id = ${history.profileId} and report_type = 'sdCampaigns'`;
  // The unreconciled load keeps its observation but claims nothing; the failed load claims nothing.
  expect(sd).toMatchObject({ counts_match: false });
});

it('is idempotent: running it again, or reapplying the migration, changes nothing', async () => {
  const before = await database.sql`select * from public.report_coverage order by id`;
  expect(await database.sql`select * from app.backfill_report_coverage_days()`).toEqual([
    { created_rows: 0, claimed_rows: 5, changed_rows: 0, held_days: '15' },
  ]);
  await applySqlFile(database, MIGRATION);
  expect(await database.sql`select * from public.report_coverage order by id`).toEqual(before);
  // The WP-256 ledger backfill command claims the same days and moves no span. It
  // still files core families under their report type as grain, which holds no day.
  const spansBefore = await spans(history.profileId);
  await backfillReportCoverage(database);
  const after = await spans(history.profileId);
  expect(after.filter((row) => row.grain !== 'spAdvertisedProduct')).toEqual(spansBefore);
  expect(after.find((row) => row.grain === 'spAdvertisedProduct')).toMatchObject({ earliest_returned_date: null });
});

it('yields the spans the worker producer records for the same history', async () => {
  produced = await tenant('coverage-backfill-produced');
  const { ordered } = await seedHistory(produced);
  for (const request of [...ordered].sort((a, b) => a.completedAt.localeCompare(b.completedAt))) {
    const accounting = { sourceRows: request.loaded, parsedRows: request.loaded, refusedRows: 0,
      observedAt: request.completedAt, settledThrough: null };
    if (request.reportType !== 'spAdvertisedProduct') {
      await recordReportCoverage(database, request.id, accounting);
      continue;
    }
    await upsertReportCoverage(database, {
      orgId: produced.orgId, profileId: produced.profileId, reportType: 'spAdvertisedProduct', grain: CORE_GRAIN,
      source: 'amazon_reporting_v3', status: 'complete', earliestDate: '2026-09-01', coveredThrough: '2026-09-02',
      settledThrough: null, observedAt: request.completedAt, sourceRows: 1, parsedRows: 1, loadedRows: 1,
      refusedRows: 0, countsMatch: true,
    }, 1, { loadedBy: request.id });
  }
  const recorded = await spans(produced.profileId);
  expect(seeded.ordered).toHaveLength(ordered.length);
  expect(recorded.map((row) => row.report_type)).toEqual(['sbAds', 'sbCampaigns', 'spAdvertisedProduct', 'spTargeting']);
  expect(recorded).toEqual((await spans(history.profileId))
    .filter((row) => recorded.some((own) => own.report_type === row.report_type && own.grain === row.grain)));
});
