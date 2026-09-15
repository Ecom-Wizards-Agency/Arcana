import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../testing/harness.js';
import { readProfileFreshness } from './freshness.js';
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
