import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable, type TestDatabase } from './testing/harness.js';
import { withAuthenticatedActor } from './queries/authenticated-actor.js';
import { acceptAgencyBootstrapInvitation } from './queries/agency-bootstrap.js';
import { acceptTeamInvitation, teamInvitationDeliveryContext } from './queries/team-invitation-acceptance.js';
import { provisionAgency, reissueAgencyBootstrapInvitation, revokeAgencyBootstrapInvitation } from './operator.js';

const available = await databaseAvailable();
const digest = () => {
  const raw = randomBytes(32).toString('base64url');
  return { tokenHash: createHash('sha256').update(raw).digest('hex'), tokenPrefix: raw.slice(0, 12) };
};

describe.skipIf(!available)('service-role membership write fence', () => {
  let database: TestDatabase;
  let service: postgres.Sql;
  let migration: string;
  let commandsBefore: unknown;

  async function commandCatalog() {
    return database.sql`
      select p.oid::regprocedure::text as signature, p.proowner::regrole::text as owner,
             p.prosecdef as definer, p.proacl::text as acl, p.prosrc as body
        from pg_proc p where p.pronamespace = 'app'::regnamespace
         and p.proname in ('lock_org_manager','list_org_members','issue_team_invitation',
           'revoke_team_invitation','change_org_member_role','remove_org_member',
           'provision_agency','reissue_bootstrap_invitation','revoke_bootstrap_invitation',
           'bootstrap_delivery_context','accept_bootstrap_invitation',
           'team_invitation_delivery_context','accept_team_invitation')
       order by p.proname
    `;
  }

  beforeAll(async () => {
    database = await createTestDatabase('membership_fence', {
      throughMigration: '20260907060000_verified_team_invitation_acceptance.sql', applyFixture: false,
    });
    migration = await readFile(new URL('../../../supabase/migrations/20260907070000_service_role_membership_write_fence.sql', import.meta.url), 'utf8');
    commandsBefore = await commandCatalog();
    const before = await database.sql`
      select has_table_privilege('service_role','public.org_members','INSERT') as member_insert,
             has_table_privilege('service_role','public.org_invitations','UPDATE') as invitation_update
    `;
    expect(before).toEqual([{ member_insert: true, invitation_update: true }]);
    await database.sql.begin((sql) => sql.unsafe(migration));
    // A genuine pool/transaction boundary, without changing any cluster role.
    service = postgres(database.connectionString, {
      max: 1, prepare: false, onnotice: () => {},
      connection: { role: 'service_role', 'request.jwt.claims': '{"role":"service_role"}' },
    });
    expect(await service`select current_user::text as role`).toEqual([{ role: 'service_role' }]);
  }, 60_000);
  afterAll(async () => {
    await service?.end({ timeout: 5 });
    await database?.drop();
  });

  async function user(email = `${randomUUID()}@example.test`) {
    const id = randomUUID();
    await database.sql`insert into auth.users(id,email,email_confirmed_at) values (${id},${email},now())`;
    return { id, email };
  }

  async function provision() {
    const token = digest();
    const owner = await user();
    const receipt = await provisionAgency({ sql: service }, {
      requestId: randomUUID(), name: 'Synthetic fenced agency', slug: `fenced-${randomUUID()}`,
      ownerEmail: owner.email, token,
    });
    return { token, owner, receipt, orgId: receipt.orgId };
  }

  async function agency() {
    const created = await provision();
    expect(await acceptAgencyBootstrapInvitation(database, { userId: created.owner.id }, created.token.tokenHash))
      .toMatchObject({ orgId: created.orgId, outcome: 'accepted' });
    return created;
  }

  async function issue(orgId: string, manager: string, role: 'admin' | 'viewer' = 'viewer') {
    const recipient = await user();
    const token = digest();
    const [row] = await withAuthenticatedActor(database, { orgId, userId: manager }, (sql) => sql<{ id: string }[]>`
      select app.issue_team_invitation(${orgId},${recipient.email},${role}::public.org_role,
        ${token.tokenHash},${token.tokenPrefix}) as id
    `);
    return { recipient, token, id: row!.id };
  }

  it('preserves all 13 command owners, bodies and ACLs while removing effective service table/column DML', async () => {
    const after = await commandCatalog();
    expect(after).toHaveLength(13);
    expect(after).toEqual(commandsBefore);
    expect(after.every((command) => command.definer === true && command.owner !== 'service_role')).toBe(true);
    const privileges = await database.sql`
      select c.relname as relation,
             has_table_privilege('service_role',c.oid,'INSERT,UPDATE,DELETE') as table_write,
             has_any_column_privilege('service_role',c.oid,'INSERT,UPDATE') as column_write,
             has_table_privilege('service_role',c.oid,'SELECT') as service_read,
             has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE') as operator_write
        from pg_class c where c.oid in ('public.org_members'::regclass,'public.org_invitations'::regclass)
       order by c.relname
    `;
    expect(privileges).toEqual(['org_invitations', 'org_members'].map((relation) => ({
      relation, table_write: false, column_write: false, service_read: true, operator_write: true,
    })));
    // This fence intentionally does not constrain the database owner used for
    // fixture setup, or a deployed login with separate inherited authority.
  });

  it('refuses legacy direct claim/add/remove statements and leaves invitation, members and audit unchanged', async () => {
    const { orgId, owner } = await agency();
    const invitation = await issue(orgId, owner.id);
    await database.sql`update public.org_members set role='viewer' where org_id=${orgId} and user_id=${owner.id}`;
    await expect(acceptTeamInvitation(database, { userId: invitation.recipient.id }, invitation.token.tokenHash))
      .rejects.toMatchObject({ code: '42501' });

    // The old web claim's effective statement, including its pending checks.
    await expect(service`
      update public.org_invitations set accepted_at=now(),accepted_by=${invitation.recipient.id}
       where token_hash=${invitation.token.tokenHash} and accepted_at is null
         and revoked_at is null and expires_at>now() returning id
    `).rejects.toMatchObject({ code: '42501' });
    // The old addMember opened a separate service-owned transaction.
    await expect(service.begin((sql) => sql`
      insert into public.org_members(org_id,user_id,role)
      values (${orgId},${invitation.recipient.id},'viewer')
      on conflict (org_id,user_id) do nothing returning user_id
    `)).rejects.toMatchObject({ code: '42501' });
    await expect(service`delete from public.org_members where org_id=${orgId} and user_id=${owner.id}`)
      .rejects.toMatchObject({ code: '42501' });
    const [counts] = await database.sql`
      select (select count(*)::int from public.org_members where org_id=${orgId}) as members,
             (select count(*)::int from public.audit_log where org_id=${orgId}) as audits,
             (select count(*)::int from public.org_invitations where org_id=${orgId}
                and accepted_at is null and accepted_by is null and revoked_at is null) as pending
    `;
    expect(counts).toEqual({ members: 1, audits: 3, pending: 1 });
  });

  it('preserves owner/admin issue, verified acceptance, role change, revocation and member removal with exact counts', async () => {
    const { orgId, owner } = await agency();
    const admin = await issue(orgId, owner.id, 'admin');
    expect(await teamInvitationDeliveryContext(database, { orgId, userId: owner.id }, admin.token.tokenHash))
      .toEqual({ invitationId: admin.id, email: admin.recipient.email });
    expect(await acceptTeamInvitation(database, { userId: admin.recipient.id }, admin.token.tokenHash))
      .toMatchObject({ orgId, outcome: 'accepted' });
    const invitation = await issue(orgId, admin.recipient.id);
    expect(await withAuthenticatedActor(database, { orgId, userId: admin.recipient.id }, (sql) => sql`
      select app.revoke_team_invitation(${orgId},${invitation.id}) as changed
    `)).toEqual([{ changed: true }]);
    await expect(withAuthenticatedActor(database, { orgId, userId: admin.recipient.id }, (sql) => sql`
      select app.change_org_member_role(${orgId},${owner.id},'viewer')
    `)).rejects.toMatchObject({ code: '42501' });
    expect(await withAuthenticatedActor(database, { orgId, userId: owner.id }, (sql) => sql`
      select app.change_org_member_role(${orgId},${admin.recipient.id},'analyst') as changed
    `)).toEqual([{ changed: 1 }]);
    expect(await withAuthenticatedActor(database, { orgId, userId: owner.id }, (sql) => sql`
      select app.remove_org_member(${orgId},${admin.recipient.id}) as changed
    `)).toEqual([{ changed: 1 }]);
    await expect(acceptTeamInvitation(database, { userId: admin.recipient.id }, admin.token.tokenHash))
      .rejects.toMatchObject({ code: '42501' });
    const [counts] = await database.sql`
      select (select count(*)::int from public.org_members where org_id=${orgId}) as members,
             (select count(*)::int from public.audit_log where org_id=${orgId}) as audits,
             (select count(*)::int from public.org_invitations where org_id=${orgId}) as invitations,
             (select count(*)::int from public.org_invitations where org_id=${orgId} and accepted_at is not null) as accepted,
             (select count(*)::int from public.org_invitations where org_id=${orgId} and revoked_at is not null) as revoked
    `;
    expect(counts).toEqual({ members: 1, audits: 8, invitations: 2, accepted: 1, revoked: 1 });
  });

  it('preserves service-authorized bootstrap reissue/revocation without granting operator membership', async () => {
    const { receipt, orgId } = await provision();
    const reissued = await reissueAgencyBootstrapInvitation({ sql: service }, {
      requestId: receipt.requestId, expectedGeneration: 1, token: digest(),
    });
    expect(reissued).toMatchObject({ orgId, generation: 2, outcome: 'reissued' });
    expect(await revokeAgencyBootstrapInvitation({ sql: service }, { requestId: receipt.requestId, expectedGeneration: 2 })).toBe(true);
    const [counts] = await database.sql`
      select (select count(*)::int from public.org_members where org_id=${orgId}) as members,
             (select count(*)::int from public.audit_log where org_id=${orgId}) as audits,
             (select count(*)::int from app.agency_bootstrap_invitations where org_id=${orgId} and revoked_at is not null) as revoked
    `;
    expect(counts).toEqual({ members: 0, audits: 3, revoked: 1 });
  });

  it('refuses an effective PUBLIC bypass without changing that unrelated grant', async () => {
    await expect(database.sql.begin(async (sql) => {
      await sql`grant update on public.org_invitations to public`;
      await sql.unsafe(migration);
    })).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('write authority remains') });
    expect(await service`select has_any_column_privilege(current_user,'public.org_invitations','UPDATE') as writable`)
      .toEqual([{ writable: false }]);
  });

  it('also removes direct service column grants through PostgreSQL table revocation', async () => {
    await database.sql.begin(async (sql) => {
      await sql`grant update(accepted_at) on public.org_invitations to service_role`;
      expect(await sql`select has_any_column_privilege('service_role','public.org_invitations','UPDATE') as writable`)
        .toEqual([{ writable: true }]);
      await sql.unsafe(migration);
    });
    expect(await service`select has_any_column_privilege(current_user,'public.org_invitations','UPDATE') as writable`)
      .toEqual([{ writable: false }]);
  });
});
