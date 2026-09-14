import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../testing/harness.js';
import { asUser } from '../testing/rls.js';
import { withAuthenticatedOrgEditor, withAuthenticatedReadSnapshot } from './authenticated-actor.js';
import { listGridViews, saveGridViews, removeGridView } from './grid-views.js';
import type { GridSavedView } from '@wizard-ads/shared';

const view: GridSavedView = { id: 'synthetic-view', name: 'Synthetic analysis', entity: 'targets',
  columns: ['targeting', 'spend'], widths: {}, pinned: ['targeting'], density: 'compact',
  sort: [], filter: { groups: [] }, groupBy: [], collapsedGroupIds: [], dateRange: null, updatedAt: '2026-09-14' };
describe('org saved views', () => {
  let db: TestDatabase;
  const a = { orgId: '', userId: randomUUID() };
  const b = { orgId: '', userId: randomUUID() };
  beforeAll(async () => {
    db = await createTestDatabase('grid_views');
    for (const [index, actor] of [a, b].entries()) {
      const rows = await db.sql<{ id: string }[]>`select app.seed_tenant_fixture(${'views-' + index}, ${actor.userId}, 'owner') as id`;
      actor.orgId = rows[0]!.id;
    }
  }, 60_000);
  afterAll(async () => { await db?.drop(); });
  it('round trips all rows through editor admission and a read snapshot', async () => {
    expect(await withAuthenticatedOrgEditor(db, a, (tx) => saveGridViews(tx, { profileId: null, views: [view, { ...view, id: 'second' }] }))).toBe(2);
    expect(await withAuthenticatedReadSnapshot(db, a, (tx) => listGridViews(tx, 'targets', null))).toEqual([view, { ...view, id: 'second' }].sort((x,y) => x.id.localeCompare(y.id)));
  });
  it('refuses cross-agency reads, inserts, updates and deletes under RLS', async () => {
    expect(await withAuthenticatedReadSnapshot(db, b, (tx) => listGridViews(tx, 'targets', null))).toEqual([]);
    await asUser(db, b.userId, async (sql) => {
      expect(await sql`select id from public.grid_views where org_id=${a.orgId}`).toHaveLength(0);
      expect(await sql`update public.grid_views set name='Forbidden' where org_id=${a.orgId} returning id`).toHaveLength(0);
      expect(await sql`delete from public.grid_views where org_id=${a.orgId} returning id`).toHaveLength(0);
      await expect(sql`insert into public.grid_views(org_id,owner_id,id,name,view) values (${a.orgId},${b.userId},'forbidden','Forbidden','{}')`).rejects.toMatchObject({ code: '42501' });
    });
    expect(await withAuthenticatedOrgEditor(db, b, (tx) => removeGridView(tx, view.id))).toBe(0);
  });
  it('shares reads with agency members while refusing viewer writes and forged membership', async () => {
    const member = { orgId: a.orgId, userId: randomUUID() };
    await db.sql`insert into auth.users(id) values (${member.userId})`;
    await db.sql`insert into public.org_members(org_id,user_id,role) values (${member.orgId},${member.userId},'viewer')`;
    expect(await withAuthenticatedReadSnapshot(db, member, (tx) => listGridViews(tx, 'targets', null))).toHaveLength(2);
    await expect(withAuthenticatedOrgEditor(db, member, (tx) => saveGridViews(tx, { profileId: null, views: [view] }))).rejects.toThrow();
    await expect(withAuthenticatedReadSnapshot(db, { ...b, orgId: a.orgId }, (tx) => listGridViews(tx, 'targets', null))).rejects.toThrow();
  });
  it('refuses another editor taking ownership and a foreign profile binding', async () => {
    const editor = { orgId: a.orgId, userId: randomUUID() };
    await db.sql`insert into auth.users(id) values (${editor.userId})`;
    await db.sql`insert into public.org_members(org_id,user_id,role) values (${editor.orgId},${editor.userId},'analyst')`;
    await expect(withAuthenticatedOrgEditor(db, editor, (tx) => saveGridViews(tx, { profileId: null, views: [{ ...view, name: 'Changed' }] }))).rejects.toThrow();
    const [foreign] = await db.sql<{ id: string }[]>`select id from public.ad_profiles where org_id=${b.orgId} limit 1`;
    await expect(withAuthenticatedOrgEditor(db, a, (tx) => saveGridViews(tx, { profileId: foreign!.id, views: [view] }))).rejects.toThrow();
    expect(await withAuthenticatedReadSnapshot(db, a, (tx) => listGridViews(tx, 'targets', null))).toHaveLength(2);
  });
  it('has the measured corridor index in the installed schema', async () => {
    const rows = await db.sql<{ indexdef: string }[]>`select indexdef from pg_indexes where indexname='bid_series_daily_org_profile_target_latest'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indexdef).toContain('(org_id, profile_id, target_id, date DESC, loaded_at DESC)');
  });
});
