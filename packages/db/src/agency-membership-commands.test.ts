import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable, type TestDatabase } from './testing/harness.js';
import { withAuthenticatedActor } from './queries/authenticated-actor.js';

const available = await databaseAvailable();
const OWNER = '81818181-8181-4181-8181-818181818181';
const ADMIN = '92929292-9292-4292-8292-929292929292';
const VIEWER = 'a3a3a3a3-a3a3-43a3-83a3-a3a3a3a3a3a3';
const FOREIGN_OWNER = 'b4b4b4b4-b4b4-44b4-84b4-b4b4b4b4b4b4';

describe.skipIf(!available)('agency membership commands', () => {
  let database: TestDatabase;
  let orgId: string;
  let foreignOrg: string;

  beforeAll(async () => {
    database = await createTestDatabase('agency_members');
    const [row] = await database.sql<{ a: string; b: string }[]>`
      select app.seed_tenant_fixture('members-a', ${OWNER}, 'owner') as a,
             app.seed_tenant_fixture('members-b', ${FOREIGN_OWNER}, 'owner') as b
    `;
    orgId = row!.a; foreignOrg = row!.b;
    for (const [userId, role] of [[ADMIN, 'admin'], [VIEWER, 'viewer']] as const) {
      await database.sql`select public.auth_user_stub(${userId})`;
      await database.sql`insert into public.org_members(org_id,user_id,role) values (${orgId},${userId},${role})`;
    }
  }, 60_000);
  afterAll(async () => { await database?.drop(); });

  const actor = (userId: string) => ({ orgId, userId });

  async function issue(userId: string, email = `${randomUUID()}@example.test`) {
    return withAuthenticatedActor(database, actor(userId), async (sql) => {
      const [row] = await sql<{ id: string }[]>`
        select app.issue_team_invitation(${orgId},${email},'analyst',${randomUUID().replaceAll('-', '').repeat(2)},'abcdefghijkl') as id
      `;
      return row!.id;
    });
  }

  async function counts() {
    const [row] = await database.sql`
      select (select count(*)::integer from public.org_invitations where org_id = ${orgId}) as invitations,
             (select count(*)::integer from public.audit_log where org_id = ${orgId}
               and action in ('invitation.created','invitation.revoked','member.role_changed','member.removed')) as audits
    `;
    return row;
  }

  it('issues and revokes exactly one invitation and two matching actor audits', async () => {
    const before = await counts();
    const id = await issue(ADMIN);
    const [stored] = await database.sql`select invited_by,role::text from public.org_invitations where id=${id}`;
    expect(stored).toEqual({ invited_by: ADMIN, role: 'analyst' });
    const outcomes = await withAuthenticatedActor(database, actor(OWNER), async (sql) => {
      const first = await sql`select app.revoke_team_invitation(${orgId},${id}) as changed`;
      const replay = await sql`select app.revoke_team_invitation(${orgId},${id}) as changed`;
      return [first[0]!.changed, replay[0]!.changed];
    });
    expect(outcomes).toEqual([true, false]);
    expect(await counts()).toEqual({ invitations: Number(before!.invitations) + 1, audits: Number(before!.audits) + 2 });
    const audits = await database.sql`select actor_id,action from public.audit_log where org_id=${orgId} and target_id=${id} order by id`;
    expect(audits).toEqual([
      { actor_id: ADMIN, action: 'invitation.created' },
      { actor_id: OWNER, action: 'invitation.revoked' },
    ]);
  });

  it('refuses viewers and foreign owners with zero invitation or audit artifacts', async () => {
    const before = await counts();
    await expect(issue(VIEWER)).rejects.toMatchObject({ code: '42501' });
    await expect(issue(FOREIGN_OWNER)).rejects.toThrow('Resource not found');
    expect(await counts()).toEqual(before);
    const rows = await withAuthenticatedActor(database, { orgId: foreignOrg, userId: FOREIGN_OWNER }, async (sql) =>
      sql`select * from app.list_org_members(${orgId})`);
    expect(rows).toHaveLength(0);
  });

  it('rechecks a downgrade committed after the earlier authenticated membership read', async () => {
    const before = await counts();
    try {
      await expect(withAuthenticatedActor(database, actor(ADMIN), async (sql) => {
        await database.sql`update public.org_members set role='viewer' where org_id=${orgId} and user_id=${ADMIN}`;
        await sql`select app.issue_team_invitation(${orgId},'downgraded@example.test','analyst',${'a'.repeat(64)},'abcdefghijkl')`;
      })).rejects.toMatchObject({ code: '42501' });
      expect(await counts()).toEqual(before);
    } finally {
      await database.sql`update public.org_members set role='admin' where org_id=${orgId} and user_id=${ADMIN}`;
    }
  });

  it('retains the manager row lock through commit, including a non-key role update', async () => {
    await withAuthenticatedActor(database, actor(ADMIN), async (sql) => {
      await sql`select app.issue_team_invitation(${orgId},'lock-test@example.test','viewer',${'b'.repeat(64)},'abcdefghijkl')`;
      await expect(database.sql.begin(async (other) => {
        await other`set local lock_timeout='100ms'`;
        await other`update public.org_members set role='viewer' where org_id=${orgId} and user_id=${ADMIN}`;
      })).rejects.toMatchObject({ code: '55P03' });
    });
    const [row] = await database.sql`select role::text from public.org_members where org_id=${orgId} and user_id=${ADMIN}`;
    expect(row!.role).toBe('admin');
  });

  it('serializes duplicate invitations and persists one counted winner', async () => {
    const before = await counts();
    const email = 'duplicate@example.test';
    const outcomes = await Promise.allSettled([issue(OWNER, email), issue(ADMIN, email)]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const refused = outcomes.find((result) => result.status === 'rejected');
    expect(refused).toMatchObject({ status: 'rejected', reason: { code: '23505' } });
    expect(await counts()).toEqual({ invitations: Number(before!.invitations) + 1, audits: Number(before!.audits) + 1 });
  });

  it('blocks direct DML and admin ownership changes at the database boundary', async () => {
    const before = await counts();
    const statements = [
      'update public.org_members set role = \'owner\' where user_id = auth.uid()',
      'delete from public.org_invitations',
    ];
    for (const statement of statements) {
      await expect(withAuthenticatedActor(database, actor(ADMIN), (sql) => sql.unsafe(statement)))
        .rejects.toMatchObject({ code: '42501' });
    }
    for (const userId of [ADMIN, OWNER]) {
      await expect(withAuthenticatedActor(database, actor(ADMIN), (sql) =>
        sql`select app.change_org_member_role(${orgId},${userId},'owner')`)).rejects.toMatchObject({ code: '42501' });
    }
    await expect(withAuthenticatedActor(database, actor(ADMIN), (sql) =>
      sql`select app.remove_org_member(${orgId},${OWNER})`)).rejects.toMatchObject({ code: '42501' });
    await expect(withAuthenticatedActor(database, actor(OWNER), (sql) =>
      sql`select app.issue_team_invitation(${orgId},'owner-invite@example.test','owner',${'c'.repeat(64)},'abcdefghijkl')`))
      .rejects.toMatchObject({ code: '22023' });
    expect(await counts()).toEqual(before);
    const policies = await database.sql`
      select tablename,cmd from pg_policies where schemaname='public'
       and tablename in ('org_members','org_invitations') order by tablename
    `;
    expect(policies).toEqual([
      { tablename: 'org_invitations', cmd: 'SELECT' },
      { tablename: 'org_members', cmd: 'SELECT' },
    ]);
  });

  it('preserves one owner when two owners concurrently demote themselves', async () => {
    const secondOwner = randomUUID();
    const [seed] = await database.sql<{ id: string }[]>`
      select app.seed_tenant_fixture('owners-race', ${secondOwner}, 'owner') as id
    `;
    const raceOrg = seed!.id;
    await database.sql`insert into public.org_members(org_id,user_id,role) values (${raceOrg},${OWNER},'owner')`;
    const outcomes = await Promise.all([OWNER, secondOwner].map((userId) =>
      withAuthenticatedActor(database, { orgId: raceOrg, userId }, async (sql) => {
        const [row] = await sql<{ changed: number }[]>`select app.change_org_member_role(${raceOrg},${userId},'admin') as changed`;
        return row!.changed;
      })));
    expect(outcomes.sort()).toEqual([0, 1]);
    const [row] = await database.sql`
      select (select count(*)::integer from public.org_members where org_id=${raceOrg} and role='owner') as owners,
             (select count(*)::integer from public.audit_log where org_id=${raceOrg} and action='member.role_changed') as audits
    `;
    expect(row).toEqual({ owners: 1, audits: 1 });
  });
});
