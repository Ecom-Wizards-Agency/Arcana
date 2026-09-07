import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '../testing/harness.js';
import { asAnon, asServiceRole, asUser } from '../testing/rls.js';
import { withAuthenticatedOrgEditor } from './authenticated-actor.js';
import { bulkAssignTagByFilter, createTag, deleteTagInTransaction, updateTag } from './tags.js';
import { createGotoLink } from './goto.js';

const available = await databaseAvailable();
const signingSecret = ['synthetic', 'editor', 'goto', 'signing', 'material'].join('-');
interface Agency { orgId: string; userId: string; profileId: string }

describe.skipIf(!available)('locked authenticated agency editing', () => {
  let database: TestDatabase;
  const agencies: Agency[] = [];
  beforeAll(async () => {
    database = await createTestDatabase('org_editor');
    for (let i = 0; i < 3; i++) {
      const userId = randomUUID();
      const [org] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture(${randomUUID()},${userId},'owner') as id`;
      const [profile] = await database.sql<{ id: string }[]>`select id from public.ad_profiles where org_id=${org!.id}`;
      agencies.push({ userId, orgId: org!.id, profileId: profile!.id });
    }
  }, 60_000);
  afterAll(async () => { await database?.drop(); });
  const actor = (agency: Agency) => ({ orgId: agency.orgId, userId: agency.userId });
  function latch() {
    let release!: () => void;
    return { promise: new Promise<void>((resolve) => { release = resolve; }), release: () => release() };
  }
  async function waitForLock(fragment: string) {
    for (let i = 0; i < 200; i++) {
      const waiting = await database.sql`select pid from pg_stat_activity where datname=current_database()
        and wait_event_type='Lock' and position(${fragment} in query)>0`;
      if (waiting.length > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Expected synthetic operation to wait for its lock');
  }

  it('admits only current editors in each selected agency with exact persisted counts', async () => {
    const before = await database.sql<{ org_id: string; count: number }[]>`
      select org_id, count(*)::int as count from public.goto_links group by org_id order by org_id`;
    let admitted = 0; let refused = 0;
    for (const agency of agencies) {
      for (const role of ['owner', 'admin', 'analyst', 'viewer'] as const) {
        await database.sql`update public.org_members set role=${role} where org_id=${agency.orgId} and user_id=${agency.userId}`;
        const operation = withAuthenticatedOrgEditor(database, actor(agency), async (context) => {
          expect(await context.sql`select current_user as role, auth.uid() as subject`).toEqual([{ role: 'authenticated', subject: agency.userId }]);
          const tag = await createTag(context, { orgId: context.actor.orgId, createdBy: context.actor.userId, name: randomUUID() });
          const link = await createGotoLink(context, { orgId: context.actor.orgId, createdBy: context.actor.userId,
            route: '/tags', state: { synthetic: [role, null, 1] }, signingSecret });
          expect(link).toMatchObject({ orgId: agency.orgId, createdBy: agency.userId });
          expect(await deleteTagInTransaction(context, { tagId: tag.id, disposition: { mode: 'detach' } }))
            .toMatchObject({ associations: 0, detached: 0, childrenMoved: 0 });
        });
        if (role === 'viewer') { await expect(operation).rejects.toMatchObject({ code: '42501' }); refused++; }
        else { await operation; admitted++; }
      }
      await database.sql`update public.org_members set role='owner' where org_id=${agency.orgId} and user_id=${agency.userId}`;
      for (const other of agencies.filter((other) => other !== agency)) {
        await expect(withAuthenticatedOrgEditor(database, { orgId: other.orgId, userId: agency.userId }, async () => {
          throw new Error('Foreign actor reached mutation');
        })).rejects.toMatchObject({ code: '42501' }); refused++;
      }
    }
    expect({ admitted, refused }).toEqual({ admitted: 9, refused: 9 });
    expect(await database.sql`select org_id, count(*)::int as count from public.goto_links group by org_id order by org_id`)
      .toEqual(before.map((row) => ({ ...row, count: row.count + 3 })));
  });

  it('retains membership DML restrictions and limits the lock command to authenticated callers', async () => {
    const agency = agencies[0]!;
    expect(await database.sql`select has_table_privilege('authenticated','public.org_members','UPDATE') as allowed`)
      .toEqual([{ allowed: false }]);
    await asUser(database, agency.userId, async (sql) => {
      await expect(sql`select role from public.org_members where org_id=${agency.orgId} for share`).rejects.toMatchObject({ code: '42501' });
      await sql`select app.lock_org_editor(${agency.orgId}::uuid)`;
    });
    for (const asRole of [asAnon, asServiceRole]) {
      await asRole(database, async (sql) => {
        await expect(sql`select app.lock_org_editor(${agency.orgId}::uuid)`).rejects.toMatchObject({ code: '42501' });
      });
    }
  });

  it('respects both orderings of removal and downgrade without repeating an operation', async () => {
    const agency = agencies[0]!;
    for (const change of ['remove', 'downgrade'] as const) {
      for (const first of ['authority', 'write'] as const) {
        const userId = randomUUID();
        await database.sql`insert into auth.users(id) values(${userId})`;
        await database.sql`insert into public.org_members(org_id,user_id,role) values(${agency.orgId},${userId},'analyst')`;
        const selected = { orgId: agency.orgId, userId }; const ready = latch(); const release = latch();
        let calls = 0;
        const changeAuthority = async (hold: boolean) => database.sql.begin(async (sql) => {
          if (change === 'remove') await sql`delete from public.org_members where org_id=${agency.orgId} and user_id=${userId}`;
          else await sql`update public.org_members set role='viewer' where org_id=${agency.orgId} and user_id=${userId}`;
          if (hold) { ready.release(); await release.promise; }
        });
        const write = async (hold: boolean) => withAuthenticatedOrgEditor(database, selected, async (context) => {
          calls++;
          if (hold) { ready.release(); await release.promise; }
          await createTag(context, { orgId: agency.orgId, name: userId });
        });
        if (first === 'authority') {
          const changing = changeAuthority(true); await ready.promise;
          const writing = write(false); const denied = expect(writing).rejects.toMatchObject({ code: '42501' });
          try { await waitForLock('app.lock_org_editor'); } finally { release.release(); }
          await changing; await denied; expect(calls).toBe(0);
        } else {
          const writing = write(true); await ready.promise;
          const changing = changeAuthority(false);
          try { await waitForLock(change === 'remove' ? 'delete from public.org_members' : "set role='viewer'"); }
          finally { release.release(); }
          await writing; await changing; expect(calls).toBe(1);
        }
        await expect(write(false)).rejects.toMatchObject({ code: '42501' });
        expect(await database.sql`select count(*)::int as count from public.tags where org_id=${agency.orgId} and name=${userId}`)
          .toEqual([{ count: first === 'write' ? 1 : 0 }]);
      }
    }
  });

  it('serializes inverse hierarchy moves so only an acyclic result commits', async () => {
    const agency = agencies[0]!;
    const a = await createTag(database, { orgId: agency.orgId, name: randomUUID() });
    const b = await createTag(database, { orgId: agency.orgId, name: randomUUID() });
    const ready = latch(); const release = latch();
    const first = withAuthenticatedOrgEditor(database, actor(agency), async (context) => {
      await updateTag(context, { orgId: agency.orgId, tagId: a.id, parentId: b.id });
      ready.release(); await release.promise;
    });
    await ready.promise;
    const second = withAuthenticatedOrgEditor(database, actor(agency), (context) =>
      updateTag(context, { orgId: agency.orgId, tagId: b.id, parentId: a.id }));
    const refused = expect(second).rejects.toThrow('descendants');
    try { await waitForLock('app.lock_org_editor'); } finally { release.release(); }
    await first; await refused;
    expect(await database.sql`select id,parent_id from public.tags where id=any(${[a.id,b.id]}::uuid[]) order by id`)
      .toEqual([{ id: a.id, parent_id: b.id }, { id: b.id, parent_id: null }].sort((x, y) => x.id.localeCompare(y.id)));
  });

  it('rolls back an earlier bulk insert when a later row fails under authenticated RLS', async () => {
    const agency = agencies[0]!;
    const tag = await createTag(database, { orgId: agency.orgId, name: randomUUID() });
    await database.sql`insert into public.campaigns(org_id,profile_id,amazon_id,name,state,ad_product,budget_amount,budget_type)
      select org_id,profile_id,'c-2','Synthetic second',state,ad_product,budget_amount,budget_type
      from public.campaigns where org_id=${agency.orgId} and profile_id=${agency.profileId} and amazon_id='c-1'`;
    await database.sql`create policy reject_second_assignment on public.entity_tags as restrictive for insert to authenticated
      with check(entity_id is distinct from 'c-2')`;
    try {
      await expect(withAuthenticatedOrgEditor(database, actor(agency), (context) => bulkAssignTagByFilter(context, {
        orgId: agency.orgId, tagId: tag.id, filter: { entityType: 'campaign', profileIds: [agency.profileId], entityIds: ['c-1','c-2'] },
      }))).rejects.toMatchObject({ code: '42501' });
    } finally { await database.sql`drop policy reject_second_assignment on public.entity_tags`; }
    expect(await database.sql`select * from public.entity_tags where tag_id=${tag.id}`).toEqual([]);
    expect(await withAuthenticatedOrgEditor(database, actor(agency), (context) => bulkAssignTagByFilter(context, {
      orgId: agency.orgId, tagId: tag.id, filter: { entityType: 'campaign', profileIds: [agency.profileId], entityIds: ['c-1','c-2'] },
    }))).toEqual({ matchedByFilter: 2, requested: 2, unique: 2, processed: 2, newlyAssigned: 2, skipped: 0 });
  });

  it('binds every tag parent and assignment profile/tag to the same organization', async () => {
    const [a, b] = agencies as [Agency, Agency, Agency];
    const tag = await createTag(database, { orgId: a.orgId, name: randomUUID() });
    const foreign = await createTag(database, { orgId: b.orgId, name: randomUUID() });
    await expect(database.sql`update public.tags set parent_id=${foreign.id} where id=${tag.id}`)
      .rejects.toMatchObject({ code: '23503', constraint_name: 'tags_org_parent_fkey' });
    await expect(database.sql`insert into public.entity_tags(org_id,tag_id,profile_id) values(${a.orgId},${foreign.id},${a.profileId})`)
      .rejects.toMatchObject({ code: '23503', constraint_name: 'entity_tags_org_tag_fkey' });
    await expect(database.sql`insert into public.entity_tags(org_id,tag_id,profile_id) values(${a.orgId},${tag.id},${b.profileId})`)
      .rejects.toMatchObject({ code: '23503', constraint_name: 'entity_tags_org_profile_fkey' });
    expect(await database.sql`select conname,convalidated from pg_constraint where conname=any(${[
      'tags_org_parent_fkey','entity_tags_org_tag_fkey','entity_tags_org_profile_fkey',
    ]}::text[]) order by conname`).toEqual([
      { conname: 'entity_tags_org_profile_fkey', convalidated: true },
      { conname: 'entity_tags_org_tag_fkey', convalidated: true },
      { conname: 'tags_org_parent_fkey', convalidated: true },
    ]);
  });

  it('refuses an inconsistent upgrade without repairing or losing the old rows', async () => {
    const upgrade = await createTestDatabase('tag_binding_upgrade', { throughMigration: '20260907140000_org_editor_lock.sql' });
    try {
      const [a] = await upgrade.sql<{ id: string }[]>`select app.seed_tenant_fixture(${randomUUID()},${randomUUID()},'owner') as id`;
      const [b] = await upgrade.sql<{ id: string }[]>`select app.seed_tenant_fixture(${randomUUID()},${randomUUID()},'owner') as id`;
      const parent = await createTag(upgrade, { orgId: a!.id, name: randomUUID() });
      await upgrade.sql`insert into public.tags(org_id,parent_id,name,slug) values(${b!.id},${parent.id},'Synthetic invalid child','synthetic-invalid-child')`;
      const before = await upgrade.sql`select * from public.tags order by id`;
      const migration = await readFile(new URL('../../../../supabase/migrations/20260907150000_tag_org_binding.sql', import.meta.url), 'utf8');
      await expect(upgrade.sql.begin((sql) => sql.unsafe(migration))).rejects.toMatchObject({ code: '23503' });
      expect(await upgrade.sql`select * from public.tags order by id`).toEqual(before);
      expect(await upgrade.sql`select conname from pg_constraint where conname='tags_org_identity_unique'`).toEqual([]);
    } finally { await upgrade.drop(); }
  }, 60_000);
});
