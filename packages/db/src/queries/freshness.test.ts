import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../testing/harness.js';
import { readProfileFreshness, verifiedCoverageSpan } from './freshness.js';
import { withAuthenticatedActor } from './authenticated-actor.js';

const userId = '00000000-0000-4000-8000-000000000256';
let database: TestDatabase;
let orgId: string;
let profileId: string;
beforeAll(async () => {
  database = await createTestDatabase('wp256_freshness');
  const [org] = await database.sql<{ id: string }[]>`
    select app.seed_tenant_fixture('freshness-alpha', ${userId}::uuid) as id
  `;
  orgId = org!.id;
  const [profile] = await database.sql<{ id: string }[]>`
    select id from public.ad_profiles where org_id = ${orgId} limit 1
  `;
  profileId = profile!.id;
  await database.sql`delete from public.report_coverage where profile_id = ${profileId}`;
  await database.sql`delete from public.report_requests where profile_id = ${profileId}`;
  await database.sql`
    insert into public.report_requests
      (org_id, profile_id, report_type, start_date, end_date, status, requested_at, completed_at, rows_parsed, rows_loaded)
    values (${orgId}, ${profileId}, 'spCampaigns', '2026-08-13', '2026-08-13', 'completed',
            '2026-08-14T03:00:00Z', '2026-08-14T03:25:00Z', 3, 3),
           (${orgId}, ${profileId}, 'spTargeting', '2026-08-13', '2026-08-13', 'completed',
            '2026-08-14T03:00:00Z', '2026-08-14T03:25:00Z', 4, 4)
  `;
}, 120_000);
afterAll(async () => { await database?.drop(); });

it('falls back to every ledger type, then replaces only the covered source/type', async () => {
  const actor = { orgId, userId };
  const read = () => withAuthenticatedActor(database, actor,
    (sql) => readProfileFreshness({ sql }, actor, profileId));
  const fallback = await read();
  expect(fallback.answeredBy).toBe('ledger');
  expect(fallback.entries).toHaveLength(2);
  await database.sql`
    insert into public.report_coverage
      (org_id, profile_id, report_type, grain, source, status, latest_loaded_date)
    values (${orgId}, ${profileId}, 'spCampaigns', 'profile', 'amazon_reporting_v3', 'complete', '2026-08-14'),
           (${orgId}, ${profileId}, 'sales_and_traffic', 'asin', 'secondary_import', 'complete', '2026-08-14')
  `;
  const mixed = await read();
  expect(mixed.answeredBy).toBe('mixed');
  expect(mixed.entries).toHaveLength(3);
  expect(mixed.entries.filter((row) => row.reportType === 'spCampaigns')).toHaveLength(1);
  expect(mixed.entries.find((row) => row.reportType === 'sales_and_traffic')).toMatchObject({
    source: 'secondary_import', coveredThrough: '2026-08-14', loadedRows: null,
  });
  expect(mixed.entries.find((row) => row.reportType === 'spTargeting')).toMatchObject({ rowsLoaded: 4 });
  expect(await withAuthenticatedActor(database, actor,
    (sql) => readProfileFreshness({ sql }, { ...actor, orgId: userId }, profileId)))
    .toEqual({ entries: [], answeredBy: 'none' });
});

it('reports the verified span Ads families record and marks one with no held day not measured', async () => {
  const actor = { orgId, userId };
  await database.sql`delete from public.report_coverage where profile_id = ${profileId}`;
  await database.sql`
    insert into public.report_coverage
      (org_id, profile_id, report_type, grain, source, status, earliest_returned_date, latest_loaded_date, missing_dates)
    values (${orgId}, ${profileId}, 'spTargeting', 'sp_target', 'amazon_reporting_v3', 'complete',
            '2026-09-01', '2026-09-08', '{2026-09-04,2026-09-05,2026-09-08}'),
           (${orgId}, ${profileId}, 'sbCampaigns', 'sb', 'amazon_reporting_v3', 'complete', null, '2026-09-08', '{}'),
           (${orgId}, ${profileId}, 'sales_and_traffic', 'asin', 'secondary_import', 'complete', null, '2026-09-08', '{}')
  `;
  const { entries } = await withAuthenticatedActor(database, actor,
    (sql) => readProfileFreshness({ sql }, actor, profileId));
  expect(entries.find((row) => row.reportType === 'spTargeting')).toMatchObject({
    coveredThrough: '2026-09-08', verified: { from: '2026-09-01', through: '2026-09-07', daysHeld: 5, gapDays: 2 },
  });
  expect(entries.find((row) => row.reportType === 'sbCampaigns')).toMatchObject({ verified: null });
  expect(entries.find((row) => row.reportType === 'sales_and_traffic')).not.toHaveProperty('verified');
});

it('derives held days from the span, its missing dates and its trailing unreturned days', () => {
  expect(verifiedCoverageSpan(null, '2026-09-02', [])).toBeNull();
  expect(verifiedCoverageSpan('2026-09-01', '2026-09-01', [])).toEqual(
    { from: '2026-09-01', through: '2026-09-01', daysHeld: 1, gapDays: 0 });
  expect(verifiedCoverageSpan('2026-09-01', '2026-09-06', ['2026-09-02', '2026-09-05', '2026-09-06'])).toEqual(
    { from: '2026-09-01', through: '2026-09-04', daysHeld: 3, gapDays: 1 });
});
