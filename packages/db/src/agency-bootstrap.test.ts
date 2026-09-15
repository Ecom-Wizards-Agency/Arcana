import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgencyProvisionCommand } from '@wizard-ads/shared';
import { createTestDatabase, databaseAvailable, type TestDatabase } from './testing/harness.js';
import { asAnon, asServiceRole } from './testing/rls.js';
import { withAuthenticatedIdentity } from './queries/authenticated-actor.js';
import { acceptAgencyBootstrapInvitation, inspectAgencyBootstrapInvitation } from './queries/agency-bootstrap.js';
import { agencyBootstrapDeliveryContext, provisionAgency, reissueAgencyBootstrapInvitation, revokeAgencyBootstrapInvitation } from './operator.js';
import { agencyBootstrapInvitations } from './schema/agency.js';

const available = await databaseAvailable();
const digest = () => {
  const raw = randomBytes(32).toString('base64url');
  return { tokenHash: createHash('sha256').update(raw).digest('hex'), tokenPrefix: raw.slice(0, 12) };
};
const request = (): AgencyProvisionCommand => ({
  requestId: randomUUID(), name: 'Synthetic independent agency', slug: `agency-${randomUUID()}`,
  ownerEmail: `${randomUUID()}@example.test`, token: digest(),
});

describe.skipIf(!available)('agency bootstrap commands', () => {
  let database: TestDatabase;
  beforeAll(async () => { database = await createTestDatabase('agency_bootstrap'); }, 60_000);
  afterAll(async () => { await database?.drop(); });

  const provision = (input: AgencyProvisionCommand) => asServiceRole(database, (sql) => provisionAgency({ sql }, input));
  const accept = (userId: string, input: AgencyProvisionCommand) =>
    acceptAgencyBootstrapInvitation(database, { userId }, input.token.tokenHash);
  const reissue = (input: AgencyProvisionCommand, expectedGeneration = 1) =>
    asServiceRole(database, (sql) => reissueAgencyBootstrapInvitation({ sql }, {
      requestId: input.requestId, expectedGeneration, token: input.token,
    }));
  const revoke = (input: AgencyProvisionCommand, expectedGeneration = 1) =>
    asServiceRole(database, (sql) => revokeAgencyBootstrapInvitation({ sql }, { requestId: input.requestId, expectedGeneration }));
  async function user(email: string, confirmed = true) {
    const id = randomUUID();
    await database.sql`insert into auth.users(id,email,email_confirmed_at) values (${id},${email},${confirmed ? new Date().toISOString() : null})`;
    return id;
  }
  async function artifacts(orgId: string) {
    const [row] = await database.sql`
      select (select count(*)::int from public.orgs where id=${orgId}) as orgs,
             (select count(*)::int from app.agency_bootstrap_invitations where org_id=${orgId}) as invitations,
             (select count(*)::int from public.org_members where org_id=${orgId}) as members,
             (select count(*)::int from public.ads_connections where org_id=${orgId}) as connections,
             (select count(*)::int from public.ad_profiles where org_id=${orgId}) as profiles,
             (select count(*)::int from public.profile_strategy where org_id=${orgId}) as strategies,
             (select count(*)::int from public.audit_log where org_id=${orgId}) as audits
    `;
    return row;
  }

  it('atomically provisions one empty agency and no operator membership or copied settings', async () => {
    const input = request();
    const receipt = await provision(input);
    expect(receipt).toMatchObject({ requestId: input.requestId, generation: 1, state: 'pending', outcome: 'created', tokenMatches: true });
    expect(await artifacts(receipt.orgId)).toEqual({ orgs: 1, invitations: 1, members: 0, connections: 0, profiles: 0, strategies: 0, audits: 1 });
    const [audit] = await database.sql`select actor_type,actor_id,source,action,payload from public.audit_log where org_id=${receipt.orgId}`;
    expect(audit).toMatchObject({ actor_type: 'service', source: 'operator', action: 'agency.provisioned', payload: { requestId: input.requestId, generation: 1 } });
    expect(JSON.stringify(audit)).not.toContain(input.token.tokenHash);
  });

  it('serializes creation retries while retaining the original token and one audit', async () => {
    const input = request();
    const results = await Promise.all([provision(input), provision(input), provision(input)]);
    expect(new Set(results.map((result) => result.orgId)).size).toBe(1);
    expect(results.map((result) => result.outcome).sort()).toEqual(['created', 'existing', 'existing']);
    const forgottenToken = await provision({ ...input, token: digest() });
    expect(forgottenToken).toMatchObject({ orgId: results[0]!.orgId, outcome: 'existing', generation: 1, tokenMatches: false });
    expect(await artifacts(results[0]!.orgId)).toMatchObject({ orgs: 1, invitations: 1, members: 0, audits: 1 });
    expect(await inspectAgencyBootstrapInvitation(database, input.token.tokenHash)).toMatchObject({ state: 'pending', ownerEmail: input.ownerEmail });
  });

  it('rejects request reuse and competing slug creation with no partial organization', async () => {
    const input = request();
    const receipt = await provision(input);
    for (const change of [{ name: 'Changed agency' }, { slug: 'different-agency' }, { ownerEmail: 'different@example.test' }]) {
      await expect(provision({ ...input, ...change })).rejects.toMatchObject({ code: '22023' });
    }
    await expect(provision({ ...request(), slug: input.slug })).rejects.toMatchObject({ code: '23505' });
    const [counts] = await database.sql`select count(*)::int as count from public.orgs where slug=${input.slug}`;
    expect(counts!.count).toBe(1);
    expect(await artifacts(receipt.orgId)).toMatchObject({ invitations: 1, audits: 1 });
    const raced = request();
    const results = await Promise.allSettled([provision(raced), provision({ ...request(), slug: raced.slug })]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([expect.objectContaining({ reason: expect.objectContaining({ code: '23505' }) })]);
  });

  it('accepts the verified canonical recipient once under concurrent requests', async () => {
    const input = request();
    const receipt = await provision(input);
    const ownerId = await user(input.ownerEmail.toUpperCase());
    const results = await Promise.all([accept(ownerId, input), accept(ownerId, input), accept(ownerId, input)]);
    expect(results.map((result) => result.outcome).sort()).toEqual(['accepted', 'already_accepted', 'already_accepted']);
    for (const result of results) expect(result).toMatchObject({ orgId: receipt.orgId, invitationId: receipt.invitationId, generation: 1 });
    const rows = await database.sql`select user_id,role::text from public.org_members where org_id=${receipt.orgId}`;
    expect(rows).toEqual([{ user_id: ownerId, role: 'owner' }]);
    expect(await artifacts(receipt.orgId)).toMatchObject({ orgs: 1, invitations: 1, members: 1, audits: 2 });
    expect(await inspectAgencyBootstrapInvitation(database, input.token.tokenHash)).toMatchObject({ state: 'accepted' });
  });

  it('rejects wrong email, unconfirmed email, missing user, forged email claims and unknown token', async () => {
    const input = request();
    const receipt = await provision(input);
    const wrongId = await user('wrong-recipient@example.test');
    const unconfirmedId = await user(input.ownerEmail, false);
    for (const id of [wrongId, unconfirmedId, randomUUID()]) {
      await expect(accept(id, input)).rejects.toMatchObject({ code: '42501' });
    }
    await expect(withAuthenticatedIdentity(database, { userId: wrongId }, async (sql) => {
      const claims = JSON.stringify({ sub: wrongId, role: 'authenticated', email: input.ownerEmail, email_verified: true });
      await sql`select set_config('request.jwt.claims',${claims},true)`;
      await sql`select app.accept_bootstrap_invitation(${input.token.tokenHash})`;
    })).rejects.toMatchObject({ code: '42501' });
    await expect(accept(unconfirmedId, { ...input, token: digest() })).rejects.toMatchObject({ code: '42501' });
    expect(await artifacts(receipt.orgId)).toMatchObject({ members: 0, audits: 1 });
  });

  it('locks canonical email/confirmation through acceptance commit', async () => {
    const input = request();
    await provision(input);
    const id = await user(input.ownerEmail);
    await withAuthenticatedIdentity(database, { userId: id }, async (sql) => {
      await sql`select app.accept_bootstrap_invitation(${input.token.tokenHash})`;
      await expect(database.sql.begin(async (other) => {
        await other`set local lock_timeout='100ms'`;
        await other`update auth.users set email='changed@example.test',email_confirmed_at=null where id=${id}`;
      })).rejects.toMatchObject({ code: '55P03' });
    });
    const [stored] = await database.sql`select email,email_confirmed_at is not null as confirmed from auth.users where id=${id}`;
    expect(stored).toEqual({ email: input.ownerEmail, confirmed: true });
  });

  it('never restores removed membership or promotes an already accepted owner after demotion', async () => {
    const input = request();
    const receipt = await provision(input);
    const id = await user(input.ownerEmail);
    await accept(id, input);
    await database.sql`update public.org_members set role='viewer' where org_id=${receipt.orgId} and user_id=${id}`;
    expect(await accept(id, input)).toMatchObject({ outcome: 'already_accepted' });
    const [member] = await database.sql`select role::text from public.org_members where org_id=${receipt.orgId}`;
    expect(member!.role).toBe('viewer');
    await database.sql`delete from public.org_members where org_id=${receipt.orgId} and user_id=${id}`;
    await expect(accept(id, input)).rejects.toMatchObject({ code: '42501' });
    await expect(reissue({ ...input, token: digest() })).rejects.toMatchObject({ code: '22023' });
    expect(await artifacts(receipt.orgId)).toMatchObject({ members: 0, audits: 2 });
  });

  it('refuses accepted invitation reuse by another identity with the same email', async () => {
    const input = request();
    const receipt = await provision(input);
    await accept(await user(input.ownerEmail), input);
    await expect(accept(await user(input.ownerEmail), input)).rejects.toMatchObject({ code: '42501' });
    expect(await artifacts(receipt.orgId)).toMatchObject({ members: 1, audits: 2 });
  });

  it('requires an empty agency and refuses expired or revoked invitations', async () => {
    for (const state of ['populated', 'expired', 'revoked'] as const) {
      const input = request();
      const receipt = await provision(input);
      const id = await user(input.ownerEmail);
      if (state === 'populated') {
        await database.sql`insert into public.org_members(org_id,user_id,role) values (${receipt.orgId},${id},'viewer')`;
      } else if (state === 'expired') {
        await database.sql`update app.agency_bootstrap_invitations set expires_at=clock_timestamp()-interval '1 second' where id=${receipt.invitationId}`;
      } else {
        expect(await revoke(input)).toBe(true);
        expect(await revoke(input)).toBe(false);
      }
      const before = await artifacts(receipt.orgId);
      await expect(accept(id, input)).rejects.toMatchObject({ code: '42501' });
      expect(await artifacts(receipt.orgId)).toEqual(before);
    }
  });

  it('reissues with a generation comparison, invalidates the old token and counts the winning audit', async () => {
    const input = request();
    const receipt = await provision(input);
    const id = await user(input.ownerEmail);
    const rotated = { ...input, token: digest() };
    const results = await Promise.all([reissue(rotated), reissue(rotated)]);
    expect(results.map((result) => result.outcome).sort()).toEqual(['existing', 'reissued']);
    for (const result of results) expect(result).toMatchObject({ generation: 2, tokenMatches: true, state: 'pending' });
    expect(await inspectAgencyBootstrapInvitation(database, input.token.tokenHash)).toBeNull();
    await expect(accept(id, input)).rejects.toMatchObject({ code: '42501' });
    await expect(reissue({ ...input, token: digest() })).rejects.toMatchObject({ code: '22023' });
    await expect(revoke(input)).rejects.toMatchObject({ code: '22023' });
    await expect(reissue(rotated, 2)).rejects.toMatchObject({ code: '22023' });
    expect(await artifacts(receipt.orgId)).toMatchObject({ members: 0, audits: 2 });
    expect(await accept(id, rotated)).toMatchObject({ generation: 2, outcome: 'accepted' });
    expect(await revoke(rotated, 2)).toBe(false);
  });

  it('serializes reissue against acceptance with one state-consistent result', async () => {
    const input = request();
    const receipt = await provision(input);
    const id = await user(input.ownerEmail);
    const rotated = { ...input, token: digest() };
    const results = await Promise.allSettled([accept(id, input), reissue(rotated)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const [stored] = await database.sql`select generation,accepted_at is not null as accepted from app.agency_bootstrap_invitations where id=${receipt.invitationId}`;
    if (stored!.accepted) {
      expect(stored!.generation).toBe(1);
      expect(await artifacts(receipt.orgId)).toMatchObject({ members: 1, audits: 2 });
    } else {
      expect(stored!.generation).toBe(2);
      expect(await artifacts(receipt.orgId)).toMatchObject({ members: 0, audits: 2 });
    }
  });

  it('exposes no direct bootstrap table access or provisioning capability to product users', async () => {
    const input = request();
    const receipt = await provision(input);
    const id = await user(input.ownerEmail);
    await accept(id, input);
    for (const statement of [
      'select * from app.agency_bootstrap_invitations',
      'delete from app.agency_bootstrap_invitations',
      'update app.agency_bootstrap_invitations set generation=1',
    ]) {
      await expect(withAuthenticatedIdentity(database, { userId: id }, (sql) => sql.unsafe(statement))).rejects.toMatchObject({ code: '42501' });
      await expect(asServiceRole(database, (sql) => sql.unsafe(statement))).rejects.toMatchObject({ code: '42501' });
      await expect(asAnon(database, (sql) => sql.unsafe(statement))).rejects.toMatchObject({ code: '42501' });
    }
    await expect(withAuthenticatedIdentity(database, { userId: id }, (sql) => provisionAgency({ sql }, request()))).rejects.toMatchObject({ code: '42501' });
    await expect(withAuthenticatedIdentity(database, { userId: id }, (sql) =>
      reissueAgencyBootstrapInvitation({ sql }, { requestId: input.requestId, expectedGeneration: 1, token: digest() }))).rejects.toMatchObject({ code: '42501' });
    await expect(withAuthenticatedIdentity(database, { userId: id }, (sql) =>
      revokeAgencyBootstrapInvitation({ sql }, { requestId: input.requestId, expectedGeneration: 1 }))).rejects.toMatchObject({ code: '42501' });
    const [security] = await database.sql`
      select relrowsecurity as rls,(select count(*)::int from pg_policies where schemaname='app' and tablename='agency_bootstrap_invitations') as policies
      from pg_class where oid='app.agency_bootstrap_invitations'::regclass
    `;
    expect(security).toEqual({ rls: true, policies: 0 });
    expect(await artifacts(receipt.orgId)).toMatchObject({ members: 1, audits: 2 });
  });

  it('limits anonymous inspection to an exact bearer token and restores transaction claims', async () => {
    const input = request();
    await provision(input);
    expect(await inspectAgencyBootstrapInvitation(database, input.token.tokenHash)).toEqual({
      agencyName: input.name, ownerEmail: input.ownerEmail, generation: 1, state: 'pending',
    });
    expect(await inspectAgencyBootstrapInvitation(database, digest().tokenHash)).toBeNull();
    await expect(asAnon(database, (sql) => sql`select app.accept_bootstrap_invitation(${input.token.tokenHash})`)).rejects.toMatchObject({ code: '42501' });
    const [role] = await database.sql`select current_user = session_user as restored, auth.uid() is null as empty_identity`;
    expect(role).toEqual({ restored: true, empty_identity: true });
  });

  it('binds operator delivery to the current pending recipient and token', async () => {
    const input = request();
    const receipt = await provision(input);
    const context = () => asServiceRole(database, (sql) => agencyBootstrapDeliveryContext({ sql }, input.requestId, input.token.tokenHash));
    expect(await context()).toEqual({ requestId: input.requestId, ownerEmail: input.ownerEmail, generation: 1 });
    await expect(asServiceRole(database, (sql) => agencyBootstrapDeliveryContext({ sql }, input.requestId, digest().tokenHash))).rejects.toMatchObject({ code: '42501' });
    const id = await user(input.ownerEmail);
    await expect(withAuthenticatedIdentity(database, { userId: id }, (sql) => agencyBootstrapDeliveryContext({ sql }, input.requestId, input.token.tokenHash))).rejects.toMatchObject({ code: '42501' });
    await accept(id, input);
    await expect(context()).rejects.toMatchObject({ code: '42501' });
    expect(await artifacts(receipt.orgId)).toMatchObject({ members: 1, audits: 2 });
  });

  it('mirrors every private ledger column and nullability instead of relying on the public-table RLS census', async () => {
    const rows = await database.sql<{ column_name: string; is_nullable: string }[]>`
      select column_name,is_nullable from information_schema.columns
       where table_schema='app' and table_name='agency_bootstrap_invitations' order by column_name
    `;
    const expected = getTableConfig(agencyBootstrapInvitations).columns.map((column) => ({
      column_name: column.name, is_nullable: column.notNull ? 'NO' : 'YES',
    })).sort((a, b) => a.column_name.localeCompare(b.column_name));
    expect(rows).toEqual(expected);
    expect(rows).toHaveLength(15);
  });
});
