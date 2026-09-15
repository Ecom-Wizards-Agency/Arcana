import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '../testing/harness.js';
import { createDb } from '../client.js';
import { lockPrivilegedOrgEditor } from './privileged-actor.js';
import { readOptimizationWorkspace, saveOptimizationGroupForActor, type OptimizationGroupSettings } from './optimization-groups.js';

const available = await databaseAvailable();
const settings: OptimizationGroupSettings = {
  name: 'Synthetic review', role: 'profit', targetAcos: 0.29,
  bidFloor: 0.17, bidCeiling: 3.19, bidIncreaseCap: 0.13, bidDecreaseCap: 0.31,
  placementIncreaseCap: 0.11, placementDecreaseCap: 0.27, exclusions: [],
  reviewSchedule: { version: 2, weekdays: ['monday'] }, prioritization: 'growth_first', enabled: true,
};
interface Agency { orgId: string; userId: string; profileId: string }

describe.skipIf(!available)('current actor optimization persistence', () => {
  let database: TestDatabase;
  const agencies: Agency[] = [];
  beforeAll(async () => {
    database = await createTestDatabase('optimization_authority');
    for (let i = 0; i < 3; i++) {
      const userId = randomUUID();
      const [org] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture(${randomUUID()}, ${userId}, 'owner') as id`;
      const [profile] = await database.sql<{ id: string }[]>`select id from public.ad_profiles where org_id=${org!.id}`;
      agencies.push({ orgId: org!.id, userId, profileId: profile!.id });
    }
  }, 60_000);
  afterAll(async () => { await database?.drop(); });
  const actor = ({ orgId, userId }: Agency) => ({ orgId, userId });
  const save = (agency: Agency) => saveOptimizationGroupForActor(database, actor(agency), {
    profileId: agency.profileId, settings: { ...settings, name: randomUUID() }, campaignIds: ['c-1'],
  });

  it('admits each current editor and counts exact group, assignment and user audit changes', async () => {
    const [before] = await database.sql<{ groups: number; audits: number }[]>`select
      (select count(*)::int from public.optimization_groups) as groups,
      (select count(*)::int from public.audit_log where action='optimization_group.saved') as audits`;
    let accepted = 0; let denied = 0;
    for (const agency of agencies) {
      for (const role of ['owner', 'admin', 'analyst', 'viewer'] as const) {
        await database.sql`update public.org_members set role=${role} where org_id=${agency.orgId} and user_id=${agency.userId}`;
        if (role === 'viewer') { await expect(save(agency)).rejects.toMatchObject({ code: '42501', message: 'Resource not found' }); denied++; }
        else {
          const result = await save(agency); accepted++;
          expect(result).toMatchObject({ offeredCampaigns: 1, assignedCampaigns: 1, record: { group: { orgId: agency.orgId, profileId: agency.profileId } } });
          expect(await database.sql`select assigned_by from public.campaign_optimization_assignments where org_id=${agency.orgId} and group_id=${result.record.group.id}`)
            .toEqual([{ assigned_by: agency.userId }]);
          expect(await database.sql`select actor_id,source from public.audit_log where org_id=${agency.orgId} and target_id=${result.record.group.id} and action='optimization_group.saved'`)
            .toEqual([{ actor_id: agency.userId, source: 'web' }]);
        }
      }
      await database.sql`update public.org_members set role='owner' where org_id=${agency.orgId} and user_id=${agency.userId}`;
    }
    expect({ accepted, denied }).toEqual({ accepted: 9, denied: 3 });
    expect(await database.sql`select
      (select count(*)::int from public.optimization_groups) as groups,
      (select count(*)::int from public.audit_log where action='optimization_group.saved') as audits`)
      .toEqual([{ groups: before!.groups + 9, audits: before!.audits + 9 }]);
  });

  it('binds actor and group identity after supplied fields, including a user in both agencies', async () => {
    const [a, b] = agencies as [Agency, Agency, Agency];
    await database.sql`insert into public.org_members(org_id,user_id,role) values(${b.orgId},${a.userId},'owner')`;
    const beforeB = await readOptimizationWorkspace(database, { orgId: b.orgId, profileId: b.profileId });
    const id = randomUUID();
    const input = { id, profileId: a.profileId, campaignIds: ['c-1'], orgId: b.orgId, actorId: b.userId,
      settings: { ...settings, id: randomUUID(), orgId: b.orgId, profileId: b.profileId, version: 1 } };
    const result = await saveOptimizationGroupForActor(database, actor(a), input);
    expect(result.record.group).toMatchObject({ id, version: 2, orgId: a.orgId, profileId: a.profileId });
    expect(await database.sql`select assigned_by from public.campaign_optimization_assignments where group_id=${id}`)
      .toEqual([{ assigned_by: a.userId }]);
    await expect(saveOptimizationGroupForActor(database, actor(a), { ...input, profileId: b.profileId })).rejects.toThrow('profile not found');
    await expect(saveOptimizationGroupForActor(database, actor(a), {
      ...input, id: beforeB.groups[0]!.group.id, settings: { ...input.settings, name: randomUUID() },
    })).rejects.toThrow('another profile');
    expect(await readOptimizationWorkspace(database, { orgId: b.orgId, profileId: b.profileId })).toEqual(beforeB);
  });

  it('rolls back settings and assignment moves when the final audit cannot be persisted', async () => {
    const agency = agencies[0]!;
    const before = await readOptimizationWorkspace(database, agency);
    await database.sql`create function public.reject_synthetic_group_audit() returns trigger language plpgsql as $$
      begin if new.action='optimization_group.saved' then raise exception 'synthetic audit refused'; end if; return new; end $$`;
    await database.sql`create trigger reject_synthetic_group_audit before insert on public.audit_log for each row execute function public.reject_synthetic_group_audit()`;
    try { await expect(save(agency)).rejects.toThrow('synthetic audit refused'); }
    finally {
      await database.sql`drop trigger reject_synthetic_group_audit on public.audit_log`;
      await database.sql`drop function public.reject_synthetic_group_audit()`;
    }
    expect(await readOptimizationWorkspace(database, agency)).toEqual(before);
  });

  it('restores the exact starting role and clears transaction-local identity after success and failure', async () => {
    const handle = createDb({ connectionString: database.connectionString, max: 1 });
    const readState = () => handle.sql`select current_user as identity, current_setting('role') as role,
      nullif(current_setting('request.jwt.claims',true),'') as claims,
      nullif(current_setting('request.jwt.claim.sub',true),'') as subject,
      nullif(current_setting('request.jwt.claim.role',true),'') as claim_role`;
    try {
      const before = await readState();
      for (const fail of [false, true]) {
        const operation = handle.sql.begin(async (sql) => {
          await sql`set local role service_role`;
          const selected = await lockPrivilegedOrgEditor(sql, actor(agencies[0]!));
          expect(Object.isFrozen(selected)).toBe(true);
          expect(await sql`select current_user as identity, current_setting('role') as role, auth.uid() as subject`)
            .toEqual([{ identity: 'service_role', role: 'service_role', subject: selected.userId }]);
          if (fail) throw new Error('synthetic rollback');
        });
        if (fail) await expect(operation).rejects.toThrow('synthetic rollback'); else await operation;
        expect(await readState()).toEqual(before);
      }
      expect(await database.sql`select
        has_table_privilege('authenticated','public.org_members','UPDATE') as members,
        has_table_privilege('authenticated','public.campaigns','UPDATE') as mirrors,
        has_table_privilege('authenticated','public.sync_jobs','INSERT') as jobs,
        has_table_privilege('authenticated','public.audit_log','INSERT') as audits`)
        .toEqual([{ members: false, mirrors: false, jobs: false, audits: false }]);
    } finally { await handle.close(); }
  });
});
