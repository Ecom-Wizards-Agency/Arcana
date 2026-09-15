import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminConnectionString, applySqlFile, createTestDatabase, databaseAvailable,
  migrationFiles, type TestDatabase,
} from './testing/harness.js';
import { asUser } from './testing/rls.js';
import { decideRecommendations } from './queries/recommendations.js';
import { reviseRecommendation } from './queries/recommendation-revisions.js';

const available = await databaseAvailable();
const directory = fileURLToPath(new URL('../../../supabase/migrations/', import.meta.url));
const baseline = '20260914120000_spapi_connection_lifecycle.sql';
const versions = ["20260915000000", "20260915010000", "20260915020000", "20260915030000", "20260915040000", "20260915050000", "20260915060000", "20260915070000", "20260915080000", "20260915090000", "20260915100000", "20260915110000", "20260915120000", "20260915130000", "20260915140000", "20260915150000", "20260915160000", "20260915170000", "20260915180000", "20260915190000", "20260915200000", "20260915210000", "20260915220000", "20260915230000", "20260915240000", "20260915250000", "20260915260000", "20260915270000", "20260915280000", "20260915290000", "20260915300000", "20260915310000", "20260915320000", "20260915330000", "20260915350000"];

// This proves the current repository schema upgrade. Historical hosted bytes have
// separate fixed pins and require an additional exact-baseline rehearsal.
describe.skipIf(!available)('integration baseline to guarded-write migration window with existing data', () => {
  let database: TestDatabase;
  const owner = randomUUID();
  const orgId = randomUUID();
  const profileId = randomUUID();
  const runId = randomUUID();
  const recommendationId = randomUUID();

  beforeAll(async () => {
    // This executable rehearsal is intentionally local, including in CI.
    const host = new URL(adminConnectionString()).hostname;
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) {
      throw new Error('Write-window rehearsal requires a loopback disposable test database');
    }
    database = await createTestDatabase('write_window', { throughMigration: baseline, applyFixture: false });
    await database.sql`insert into auth.users (id) values (${owner})`;
    await database.sql`insert into public.orgs (id,slug,name)
      values (${orgId},'write-window-fixture','Synthetic upgrade tenant')`;
    await database.sql`insert into public.org_members (org_id,user_id,role) values (${orgId},${owner},'owner')`;
    await database.sql`insert into public.ad_profiles
      (id,org_id,amazon_profile_id,region,country_code,currency_code,timezone)
      values (${profileId},${orgId},'synthetic-upgrade-profile','NA','US','USD','UTC')`;
    await database.sql`insert into public.keywords
      (org_id,profile_id,amazon_id,ad_product,state,campaign_id,ad_group_id,keyword_text,match_type,bid)
      values (${orgId},${profileId},'synthetic-upgrade-keyword','SP','enabled',
        'synthetic-upgrade-campaign','synthetic-upgrade-ad-group','synthetic keyword','exact',0.9)`;
    await database.sql`insert into public.recommendation_runs (id,org_id,profile_id,status,lookback_days)
      values (${runId},${orgId},${profileId},'succeeded',30)`;
    await database.sql`insert into public.recommendations
      (id,org_id,profile_id,run_id,reason,entity_type,entity_id,ad_product,field,current_value,proposed_value,inputs)
      values (${recommendationId},${orgId},${profileId},${runId},'high_acos','keyword',
        'synthetic-upgrade-keyword','SP','bid','0.9'::jsonb,'0.7'::jsonb,'{}'::jsonb)`;
  }, 180_000);
  afterAll(async () => { await database?.drop(); });

  it('preserves the existing proposal, changes review privileges, and leaves all dispatch gates closed', async () => {
    const files = await migrationFiles();
    expect(files.indexOf(baseline)).toBeGreaterThan(45);
    const window = versions.map((version) => {
      const matches = files.filter((file) => file.startsWith(`${version}_`));
      expect(matches).toHaveLength(1);
      return matches[0]!;
    });
    expect(files.slice(files.indexOf(baseline) + 1)).toEqual(window);

    // Current web code cannot deploy against the first window alone.
    await expect(decideRecommendations(database, {
      orgId, actorId: owner, ids: [recommendationId], decision: 'accepted',
    })).rejects.toMatchObject({ code: '42883' });
    const before = await database.sql`select id,current_value,proposed_value,inputs,status
      from public.recommendations where id = ${recommendationId}`;
    const [oldPrivilege] = await database.sql`select
      has_table_privilege('authenticated','public.recommendations','UPDATE') as allowed`;
    expect(oldPrivilege?.allowed).toBe(true);

    // Each file is a separate committed query, including the enum addition.
    // Never wrap this loop in one transaction.
    for (const file of window) await applySqlFile(database, `${directory}${file}`);

    expect(await database.sql`select id,current_value,proposed_value,inputs,status
      from public.recommendations where id = ${recommendationId}`).toEqual(before);
    const [state] = await database.sql`select
      (select count(*)::integer from public.keywords where org_id = ${orgId}) as keywords,
      (select bid::text from public.keywords where org_id = ${orgId}) as bid,
      (select count(*)::integer from public.sp_write_plans) as plans,
      (select count(*)::integer from public.sp_write_authorization_receipts) as approvals,
      (select count(*)::integer from public.sp_write_execution_requests) as requests,
      has_table_privilege('authenticated','public.recommendations','UPDATE') as direct_update`;
    expect(state).toEqual({ keywords: 1, bid: '0.9000', plans: 0, approvals: 0, requests: 0, direct_update: false });
    await expect(asUser(database, owner, (sql) => sql`
      update public.recommendations set proposed_value = '0.6'::jsonb where id = ${recommendationId}`))
      .rejects.toMatchObject({ code: '42501' });

    const revision = await reviseRecommendation(database, { orgId, userId: owner }, {
      requestId: randomUUID(), profileId, recommendationId, expectedRevisionId: null,
      proposedValue: '0.8', note: 'Synthetic review after migration',
    });
    expect(await decideRecommendations(database, {
      orgId, actorId: owner, ids: [recommendationId], decision: 'accepted',
      expectedRevisions: [{ recommendationId, revisionId: revision.revisionId }],
    })).toEqual({ updated: 1, refused: [] });
    const [counts] = await database.sql`select
      (select count(*)::integer from public.recommendation_proposal_revisions) as revisions,
      (select count(*)::integer from public.sp_write_plans) as plans,
      (select count(*)::integer from public.sp_write_environment_gate_head) as environment_heads,
      (select count(*)::integer from public.sp_write_profile_grant_heads) as profile_heads`;
    expect(counts).toEqual({ revisions: 1, plans: 0, environment_heads: 0, profile_heads: 0 });
  }, 180_000);
});
