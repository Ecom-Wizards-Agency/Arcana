import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable, type TestDatabase } from './testing/harness.js';
import { asAnon, asServiceRole } from './testing/rls.js';
import { withAuthenticatedActor, withAuthenticatedIdentity } from './queries/authenticated-actor.js';
import { acceptTeamInvitation, inspectTeamInvitation, teamInvitationDeliveryContext } from './queries/team-invitation-acceptance.js';

const available = await databaseAvailable();
describe.skipIf(!available)('verified team invitation acceptance', () => {
  let database: TestDatabase;
  let orgId: string;
  const owner = randomUUID();
  beforeAll(async () => {
    database = await createTestDatabase('team_acceptance');
    const [row] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture('team-acceptance',${owner},'owner') as id`;
    orgId = row!.id;
  }, 60_000);
  afterAll(async () => { await database?.drop(); });

  async function issue() {
    const email = `${randomUUID()}@example.test`;
    const raw = randomBytes(32).toString('base64url');
    const hash = createHash('sha256').update(raw).digest('hex');
    const id = await withAuthenticatedActor(database, { orgId, userId: owner }, async (sql) => {
      const [row] = await sql<{ id: string }[]>`select app.issue_team_invitation(${orgId},${email},'analyst',${hash},${raw.slice(0, 12)}) as id`;
      return row!.id;
    });
    const userId = randomUUID();
    await database.sql`insert into auth.users(id,email,email_confirmed_at) values (${userId},${email},now())`;
    return { id, email, hash, userId };
  }
  async function count(input: Awaited<ReturnType<typeof issue>>) {
    const [row] = await database.sql`
      select (select count(*)::int from public.org_members where org_id=${orgId} and user_id=${input.userId}) as members,
             (select count(*)::int from public.audit_log where target_id=${input.id} and action='invitation.accepted') as audits,
             (select accepted_by from public.org_invitations where id=${input.id}) as accepted_by
    `;
    return row;
  }

  it('commits one original role, membership and audit under concurrent acceptance', async () => {
    const input = await issue();
    const outcomes = await Promise.all([1, 2, 3].map(() => acceptTeamInvitation(database, { userId: input.userId }, input.hash)));
    expect(outcomes.map((result) => result.outcome).sort()).toEqual(['accepted', 'already_accepted', 'already_accepted']);
    expect(await count(input)).toEqual({ members: 1, audits: 1, accepted_by: input.userId });
    const [row] = await database.sql`select role::text from public.org_members where org_id=${orgId} and user_id=${input.userId}`;
    expect(row!.role).toBe('analyst');
    expect(await inspectTeamInvitation(database, input.hash)).toMatchObject({ email: input.email, role: 'analyst', state: 'accepted' });
  });

  it('rejects wrong or unconfirmed canonical email without changing the invitation', async () => {
    const input = await issue();
    for (const change of ['unconfirmed', 'different'] as const) {
      if (change === 'unconfirmed') await database.sql`update auth.users set email_confirmed_at=null where id=${input.userId}`;
      else await database.sql`update auth.users set email='different@example.test',email_confirmed_at=now() where id=${input.userId}`;
      await expect(acceptTeamInvitation(database, { userId: input.userId }, input.hash)).rejects.toMatchObject({ code: '42501' });
      expect(await count(input)).toEqual({ members: 0, audits: 0, accepted_by: null });
    }
  });

  it('rechecks inviter authority after an earlier lookup', async () => {
    const input = await issue();
    expect(await inspectTeamInvitation(database, input.hash)).toMatchObject({ state: 'pending' });
    try {
      await database.sql`update public.org_members set role='viewer' where org_id=${orgId} and user_id=${owner}`;
      await expect(acceptTeamInvitation(database, { userId: input.userId }, input.hash)).rejects.toMatchObject({ code: '42501' });
      await expect(teamInvitationDeliveryContext(database, { orgId, userId: owner }, input.hash)).rejects.toMatchObject({ code: '42501' });
      expect(await count(input)).toEqual({ members: 0, audits: 0, accepted_by: null });
    } finally {
      await database.sql`update public.org_members set role='owner' where org_id=${orgId} and user_id=${owner}`;
    }
  });

  it('holds inviter and canonical email locks through commit', async () => {
    const input = await issue();
    await withAuthenticatedIdentity(database, { userId: input.userId }, async (sql) => {
      await sql`select app.accept_team_invitation(${input.hash})`;
      for (const table of ['auth', 'member'] as const) {
        await expect(database.sql.begin(async (other) => {
          await other`set local lock_timeout='100ms'`;
          if (table === 'auth') await other`update auth.users set email='changed@example.test' where id=${input.userId}`;
          else await other`update public.org_members set role='viewer' where org_id=${orgId} and user_id=${owner}`;
        })).rejects.toMatchObject({ code: '55P03' });
      }
    });
    expect(await count(input)).toMatchObject({ members: 1, audits: 1 });
  });

  it('does not recreate a removed member or overwrite an existing role on replay', async () => {
    const input = await issue();
    await acceptTeamInvitation(database, { userId: input.userId }, input.hash);
    await database.sql`update public.org_members set role='viewer' where org_id=${orgId} and user_id=${input.userId}`;
    expect(await acceptTeamInvitation(database, { userId: input.userId }, input.hash)).toMatchObject({ outcome: 'already_accepted' });
    const [member] = await database.sql`select role::text from public.org_members where org_id=${orgId} and user_id=${input.userId}`;
    expect(member!.role).toBe('viewer');
    await database.sql`delete from public.org_members where org_id=${orgId} and user_id=${input.userId}`;
    await expect(acceptTeamInvitation(database, { userId: input.userId }, input.hash)).rejects.toMatchObject({ code: '42501' });
    expect(await count(input)).toMatchObject({ members: 0, audits: 1 });
  });

  it('refuses expired, revoked and historical provisional invitations', async () => {
    for (const state of ['expired', 'revoked', 'provisional'] as const) {
      const input = await issue();
      if (state === 'expired') await database.sql`update public.org_invitations set expires_at=now()-interval '1 second' where id=${input.id}`;
      else if (state === 'revoked') await database.sql`update public.org_invitations set revoked_at=now() where id=${input.id}`;
      else await database.sql`update public.org_invitations set accepted_at=now(),accepted_by=null where id=${input.id}`;
      await expect(acceptTeamInvitation(database, { userId: input.userId }, input.hash)).rejects.toMatchObject({ code: '42501' });
      expect(await count(input)).toEqual({ members: 0, audits: 0, accepted_by: null });
    }
  });

  it('derives delivery email only from an exact pending invitation and denies anonymous/service acceptance', async () => {
    const input = await issue();
    expect(await teamInvitationDeliveryContext(database, { orgId, userId: owner }, input.hash)).toEqual({ invitationId: input.id, email: input.email });
    await expect(teamInvitationDeliveryContext(database, { orgId: randomUUID(), userId: owner }, input.hash)).rejects.toThrow('Resource not found');
    await expect(teamInvitationDeliveryContext(database, { orgId, userId: input.userId }, input.hash)).rejects.toThrow('Resource not found');
    for (const boundary of [asAnon, asServiceRole]) {
      await expect(boundary(database, (sql) => sql`select app.accept_team_invitation(${input.hash})`)).rejects.toMatchObject({ code: '42501' });
    }
    expect(await count(input)).toEqual({ members: 0, audits: 0, accepted_by: null });
  });

  it('rolls back both membership and invitation acceptance when its audit cannot commit', async () => {
    const input = await issue();
    await database.sql.unsafe(`create function app.test_team_audit_refusal() returns trigger language plpgsql as $$
      begin if new.action='invitation.accepted' then raise exception 'synthetic audit refusal'; end if; return new; end; $$;
      create trigger test_team_audit_refusal before insert on public.audit_log for each row execute function app.test_team_audit_refusal();`);
    try {
      await expect(acceptTeamInvitation(database, { userId: input.userId }, input.hash)).rejects.toThrow('synthetic audit refusal');
      expect(await count(input)).toEqual({ members: 0, audits: 0, accepted_by: null });
      expect(await inspectTeamInvitation(database, input.hash)).toMatchObject({ state: 'pending' });
    } finally {
      await database.sql`drop trigger test_team_audit_refusal on public.audit_log`;
      await database.sql`drop function app.test_team_audit_refusal()`;
    }
  });
});
