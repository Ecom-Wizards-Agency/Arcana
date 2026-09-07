import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import type { OrgRole } from '@wizard-ads/shared';
import { saveTargets, toggleSync, bulkSetSync, saveSchedule } from '../app/settings/profiles/actions';

let database: TestDatabase;
let actor: { orgId: string; userId: string; profileId: string };
let cachedRole: OrgRole = 'owner';
vi.mock('./auth/guard', () => ({
  gateAction: async (orgId: string) => {
    if (orgId !== actor.orgId) throw new Error('Synthetic session selected another agency');
    return { handle: database, active: { orgId: actor.orgId, role: cachedRole }, userId: actor.userId };
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const available = await databaseAvailable();
const actions = { targets: saveTargets, sync: toggleSync, bulk: bulkSetSync, schedule: saveSchedule };
type Action = keyof typeof actions;

describe.skipIf(!available)('profile action authority after the session gate', () => {
  beforeAll(async () => {
    database = await createTestDatabase('profile_action_authority');
    const userId = randomUUID();
    const [org] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture(${randomUUID()},${userId},'owner') as id`;
    const [profile] = await database.sql<{ id: string }[]>`select id from public.ad_profiles where org_id=${org!.id}`;
    actor = { orgId: org!.id, profileId: profile!.id, userId };
  }, 60_000);
  afterEach(async () => {
    vi.restoreAllMocks(); cachedRole = 'owner';
    await database.sql`insert into public.org_members(org_id,user_id,role) values(${actor.orgId},${actor.userId},'owner')
      on conflict(org_id,user_id) do update set role='owner'`;
  });
  afterAll(async () => { await database?.drop(); });
  function form(action: Action) {
    const input = new FormData();
    input.set('orgId', actor.orgId); input.set('profileId', actor.profileId);
    if (action === 'targets') { input.set('targetAcos', '31'); input.set('targetTotalAcos', '17'); input.set('goalLens', 'profit-maintain'); input.set('monthlyBudget', '127.31'); }
    if (action === 'sync' || action === 'bulk') input.set('enabled', '0');
    if (action === 'bulk') input.append('profileIds', actor.profileId);
    if (action === 'schedule') { input.set('timezone', 'UTC'); input.set('preferredSyncHour', '7'); }
    return input;
  }
  const snapshot = () => database.sql`select target_acos,target_total_acos,goal_lens,monthly_budget,sync_enabled,
    timezone,timezone_locked,preferred_sync_hour from public.ad_profiles where id=${actor.profileId}`;

  it.each(Object.keys(actions) as Action[])('%s rechecks the current role despite an earlier owner role', async (action) => {
    let admitted = 0; let refused = 0;
    const close = vi.spyOn(database, 'close');
    for (const role of ['owner', 'admin', 'analyst', 'viewer'] as const) {
      await database.sql`update public.org_members set role=${role} where org_id=${actor.orgId} and user_id=${actor.userId}`;
      const before = await snapshot(); const operation = actions[action](form(action));
      if (role === 'viewer' || (role === 'analyst' && action !== 'targets')) {
        await expect(operation).rejects.toThrow(); expect(await snapshot()).toEqual(before); refused++;
      } else { await operation; admitted++; }
    }
    expect({ admitted, refused }).toEqual(action === 'targets' ? { admitted: 3, refused: 1 } : { admitted: 2, refused: 2 });
    expect(close).not.toHaveBeenCalled();
  });

  it('refuses unchanged synchronization and schedule values after admin becomes analyst', async () => {
    cachedRole = 'admin';
    for (const action of ['sync', 'bulk', 'schedule'] as const) await actions[action](form(action));
    const before = await snapshot();
    await database.sql`update public.org_members set role='analyst' where org_id=${actor.orgId} and user_id=${actor.userId}`;
    for (const action of ['sync', 'bulk', 'schedule'] as const) {
      await expect(actions[action](form(action))).rejects.toThrow('not permitted to toggleSync');
    }
    expect(await snapshot()).toEqual(before);
  });

  it('refuses removed membership in all four actions and keeps profile SQL under authenticated RLS', async () => {
    const before = await snapshot();
    await database.sql`delete from public.org_members where org_id=${actor.orgId} and user_id=${actor.userId}`;
    for (const action of Object.keys(actions) as Action[]) {
      await expect(actions[action](form(action))).rejects.toMatchObject({ code: '42501', message: 'Resource not found' });
    }
    await database.sql`insert into public.org_members(org_id,user_id,role) values(${actor.orgId},${actor.userId},'owner')`;
    await database.sql`create policy synthetic_profile_update_denied on public.ad_profiles as restrictive for update to authenticated using(false)`;
    try { await expect(saveTargets(form('targets'))).rejects.toThrow('no profile'); }
    finally { await database.sql`drop policy synthetic_profile_update_denied on public.ad_profiles`; }
    expect(await snapshot()).toEqual(before);
  });
});
