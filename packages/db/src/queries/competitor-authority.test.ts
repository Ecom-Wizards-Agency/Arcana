import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { QuerySql } from '../client.js';
import { applySqlFile, createTestDatabase, databaseAvailable, type TestDatabase } from '../testing/harness.js';
import { withAuthenticatedActor, withAuthenticatedOrgEditor } from './authenticated-actor.js';
import { createCompetitorLink, removeCompetitorLink } from './keepa.js';

const available = await databaseAvailable();
interface Agency { orgId: string; userId: string; profileId: string }
async function seed(database: TestDatabase): Promise<Agency> {
  const userId = randomUUID();
  const [org] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture(${randomUUID()},${userId},'owner') as id`;
  const [profile] = await database.sql<{ id: string }[]>`select id from public.ad_profiles where org_id=${org!.id}`;
  return { orgId: org!.id, userId, profileId: profile!.id };
}

describe.skipIf(!available)('competitor profile agency binding', () => {
  let database: TestDatabase;
  let a: Agency; let b: Agency;
  beforeAll(async () => {
    database = await createTestDatabase('competitor_authority');
    a = await seed(database); b = await seed(database);
    await database.sql`insert into public.org_members(org_id,user_id,role) values(${b.orgId},${a.userId},'analyst')`;
  }, 60_000);
  afterAll(async () => { await database?.drop(); });

  it('rejects foreign profile inserts and updates even for a dual-agency member or privileged connection', async () => {
    let refusals = 0;
    const actor = { orgId: a.orgId, userId: a.userId };
    for (const authenticated of [false, true]) {
      const run = <T>(operation: (sql: QuerySql) => Promise<T>) => authenticated
        ? withAuthenticatedActor(database, actor, operation)
        : operation(database.sql);
      await expect(run(async (sql) => {
        await sql`insert into public.competitor_links(org_id,profile_id,our_asin,competitor_asin)
          values(${a.orgId},${b.profileId},'B0TEST0301','B0TEST0302')`;
      })).rejects.toMatchObject({ code: '23503' });
      refusals++;
      const link = await withAuthenticatedOrgEditor(database, actor, (context) => createCompetitorLink(context, {
        orgId: context.actor.orgId, profileId: a.profileId,
        ourAsin: authenticated ? 'B0TEST0303' : 'B0TEST0305', competitorAsin: 'B0TEST0304',
      }));
      expect(link.profileId).toBe(a.profileId);
      await expect(run(async (sql) => {
        await sql`update public.competitor_links set profile_id=${b.profileId} where id=${link.id} and org_id=${a.orgId}`;
      })).rejects.toMatchObject({ code: '23503' });
      refusals++;
      expect(await withAuthenticatedOrgEditor(database, actor, (context) =>
        removeCompetitorLink(context, { orgId: context.actor.orgId, id: link.id }))).toBeUndefined();
      await expect(withAuthenticatedOrgEditor(database, actor, (context) =>
        removeCompetitorLink(context, { orgId: context.actor.orgId, id: link.id }))).rejects.toThrow('Competitor link not found');
    }
    expect(refusals).toBe(4);
    expect(await database.sql`select count(*)::int as count from public.competitor_links l
      join public.ad_profiles p on p.id=l.profile_id where l.org_id<>p.org_id`).toEqual([{ count: 0 }]);
  });

  it('retains null profile scope and cascades links only when their unreferenced profile is deleted', async () => {
    const [profile] = await database.sql<{ id: string }[]>`insert into public.ad_profiles
      (org_id,amazon_profile_id,region,country_code,currency_code,timezone,account_type,account_name)
      values(${a.orgId},${randomUUID()},'NA','US','USD','UTC','seller','Synthetic cascade profile') returning id`;
    await database.sql`insert into public.competitor_links(org_id,profile_id,our_asin,competitor_asin)
      values(${a.orgId},${profile!.id},'B0TEST0311','B0TEST0312'),(${a.orgId},null,'B0TEST0313','B0TEST0314')`;
    expect(await database.sql`delete from public.ad_profiles where id=${profile!.id} returning id`).toHaveLength(1);
    expect(await database.sql`select id from public.competitor_links where profile_id=${profile!.id}`).toHaveLength(0);
    expect(await database.sql`select id from public.competitor_links where org_id=${a.orgId}
      and profile_id is null and our_asin='B0TEST0313'`).toHaveLength(1);
  });

  it('refuses invalid legacy data atomically without changing rows, grants or existing constraints', async () => {
    const prior = await createTestDatabase('competitor_upgrade', { throughMigration: '20260907150000_tag_org_binding.sql' });
    try {
      const first = await seed(prior); const second = await seed(prior);
      const [bad] = await prior.sql<{ id: string }[]>`insert into public.competitor_links
        (org_id,profile_id,our_asin,competitor_asin) values(${first.orgId},${second.profileId},'B0TEST0321','B0TEST0322') returning id`;
      const snapshot = async () => ({
        rows: await prior.sql`select * from public.competitor_links order by id`,
        grants: await prior.sql`select grantee,privilege_type from information_schema.table_privileges
          where table_schema='public' and table_name='competitor_links' order by grantee,privilege_type`,
        constraints: await prior.sql`select conname,pg_get_constraintdef(oid) as definition from pg_constraint
          where conrelid='public.competitor_links'::regclass order by conname`,
      });
      const before = await snapshot();
      const path = fileURLToPath(new URL('../../../../supabase/migrations/20260907160000_competitor_profile_binding.sql', import.meta.url));
      await expect(applySqlFile(prior, path)).rejects.toMatchObject({ code: '23503' });
      expect(await snapshot()).toEqual(before);
      expect(await prior.sql`delete from public.competitor_links where id=${bad!.id} returning id`).toHaveLength(1);
      await applySqlFile(prior, path);
      expect(await prior.sql`select convalidated from pg_constraint where conname='competitor_links_org_profile_fkey'`)
        .toEqual([{ convalidated: true }]);
      expect((await snapshot()).grants).toEqual(before.grants);
    } finally { await prior.drop(); }
  });
});
