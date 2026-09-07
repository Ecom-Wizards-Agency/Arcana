import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../client.js';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '../testing/harness.js';
import { AgencyAccessDenied, withAuthenticatedIdentity } from './authenticated-actor.js';
import {
  connectIntegrationCredentialForActor as connect,
  revokeIntegrationCredentialForActor as revoke,
  createIntegrationConnection, getIntegrationSecret, storeIntegrationSecret,
  IntegrationCredentialCommandError,
} from './integrations.js';

const available = await databaseAvailable();
interface Agency { orgId: string; userId: string }
const value = () => ['synthetic', 'integration', randomUUID()].join('-');

describe.skipIf(!available)('current agency integration credential operations', () => {
  let database: TestDatabase;
  const agencies: Agency[] = [];
  beforeAll(async () => {
    database = await createTestDatabase('integration_authority');
    for (let i = 0; i < 3; i++) {
      const userId = randomUUID();
      const [row] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture(${randomUUID()},${userId},'owner') as id`;
      agencies.push({ orgId: row!.id, userId });
    }
  }, 60_000);
  afterAll(async () => { await database?.drop(); });
  const read = (agency: Agency, label: string) => database.sql<{
    id: string; org_id: string; connected_by: string; config: unknown; status: string; vault_secret_id: string | null; last_error: string | null;
  }[]>`select id,org_id,connected_by,config,status::text,vault_secret_id,last_error
    from public.integration_connections where org_id=${agency.orgId} and label=${label}`;

  it('preserves manager-only custody and reconciles rotations, repeated revokes and exact audits across three agencies', async () => {
    let accepted = 0; let refused = 0;
    for (const agency of agencies) {
      let ownId = '';
      for (const role of ['owner', 'admin', 'analyst', 'viewer'] as const) {
        await database.sql`update public.org_members set role=${role} where org_id=${agency.orgId} and user_id=${agency.userId}`;
        const label = `matrix ${role}`;
        if (role === 'analyst' || role === 'viewer') {
          await expect(connect(database, agency, { provider: 'keepa', label }, value())).rejects.toBeInstanceOf(AgencyAccessDenied);
          await expect(revoke(database, agency, ownId)).rejects.toBeInstanceOf(AgencyAccessDenied);
          expect(await read(agency, label)).toHaveLength(0); refused += 2;
          continue;
        }
        await connect(database, agency, { provider: 'keepa', label }, value());
        const first = (await read(agency, label))[0]!;
        ownId = first.id;
        const replacement = value();
        await connect(database, agency, { provider: 'keepa', label }, replacement);
        const rotated = (await read(agency, label))[0]!;
        expect(rotated).toMatchObject({ id: ownId, org_id: agency.orgId, connected_by: agency.userId,
          status: 'active', vault_secret_id: first.vault_secret_id });
        expect(await getIntegrationSecret(database, ownId)).toBe(replacement);
        await revoke(database, agency, ownId);
        await revoke(database, agency, ownId);
        expect((await read(agency, label))[0]).toMatchObject({ status: 'revoked', vault_secret_id: null });
        const audits = await database.sql<{ org_id: string; actor_id: string; source: string; payload: unknown }[]>`
          select org_id,actor_id,source,payload from public.audit_log where target_id=${ownId} order by created_at,id`;
        expect(audits).toHaveLength(4);
        expect(audits.every((row) => row.org_id === agency.orgId && row.actor_id === agency.userId && row.source === 'web')).toBe(true);
        expect(JSON.stringify(audits)).not.toContain(replacement);
        accepted += 4;
      }
      await database.sql`update public.org_members set role='owner' where org_id=${agency.orgId} and user_id=${agency.userId}`;
    }
    expect({ accepted, refused }).toEqual({ accepted: 24, refused: 12 });
    expect(await database.sql`select count(*)::int as count from vault.secrets`).toEqual([{ count: 0 }]);
  });

  it('binds wider supplied details to the selected actor and refuses a dual-member foreign revoke', async () => {
    const a = agencies[0]!; const b = agencies[1]!;
    await database.sql`insert into public.org_members(org_id,user_id,role) values(${b.orgId},${a.userId},'owner')`;
    const label = randomUUID();
    const wider = { provider: 'datadive' as const, label, orgId: b.orgId, connectedBy: b.userId,
      config: { forged: true }, vaultSecretId: randomUUID() };
    await connect(database, a, wider, value());
    expect((await read(a, label))[0]).toMatchObject({ org_id: a.orgId, connected_by: a.userId, config: {}, status: 'active' });
    expect(await read(b, label)).toHaveLength(0);
    const foreign = await createIntegrationConnection(database, { orgId: b.orgId, provider: 'keepa', label });
    const unchanged = value(); await storeIntegrationSecret(database, foreign.id, unchanged);
    await expect(revoke(database, a, foreign.id)).rejects.toMatchObject({ code: 'not_found' });
    expect(await getIntegrationSecret(database, foreign.id)).toBe(unchanged);
    await expect(connect(database, { orgId: a.orgId, userId: agencies[2]!.userId }, { provider: 'keepa', label }, value()))
      .rejects.toBeInstanceOf(AgencyAccessDenied);
  });

  it('commits a safe failed-store state while preserving the prior credential and exact Vault count', async () => {
    const agency = agencies[0]!; const label = randomUUID(); const prior = value();
    const connection = await createIntegrationConnection(database, { orgId: agency.orgId, provider: 'keepa', label });
    const oldPointer = await storeIntegrationSecret(database, connection.id, prior);
    const before = await database.sql`select count(*)::int as count from vault.secrets`;
    await database.sql`create function public.reject_integration_activation() returns trigger language plpgsql as $$
      begin if new.status='active' then raise exception 'synthetic activation failure'; end if; return new; end $$`;
    await database.sql`create trigger reject_integration_activation before update on public.integration_connections
      for each row execute function public.reject_integration_activation()`;
    try {
      const freshLabel = randomUUID();
      await connect(database, agency, { provider: 'keepa', label: freshLabel }, value());
      await connect(database, agency, { provider: 'keepa', label }, value());
      expect((await read(agency, freshLabel))[0]).toMatchObject({ status: 'error', vault_secret_id: null });
      expect((await read(agency, label))[0]).toMatchObject({ status: 'error', vault_secret_id: oldPointer,
        last_error: 'The credential could not be stored in Vault.' });
      expect(await getIntegrationSecret(database, connection.id)).toBe(prior);
      expect(await database.sql`select count(*)::int as count from vault.secrets`).toEqual(before);
      expect(await database.sql`select count(*)::int as count from public.audit_log
        where org_id=${agency.orgId} and action='integration.credential_store_failed'`).toEqual([{ count: 2 }]);
    } finally {
      await database.sql`drop trigger reject_integration_activation on public.integration_connections`;
      await database.sql`drop function public.reject_integration_activation()`;
    }
  });

  it('rolls back a successful Vault replacement if the final audit fails and exposes no driver error', async () => {
    const agency = agencies[0]!; const label = randomUUID(); const prior = value(); const proposed = value();
    await connect(database, agency, { provider: 'mrp', label }, prior);
    const before = (await read(agency, label))[0]!;
    await database.sql`create function public.reject_integration_audit() returns trigger language plpgsql as $$
      begin if new.action like 'integration.credential_%' then raise exception 'synthetic private audit details'; end if; return new; end $$`;
    await database.sql`create trigger reject_integration_audit before insert on public.audit_log
      for each row execute function public.reject_integration_audit()`;
    try {
      let caught: unknown;
      try { await connect(database, agency, { provider: 'mrp', label }, proposed); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(IntegrationCredentialCommandError);
      const properties = Object.getOwnPropertyDescriptors(caught);
      expect(Object.keys(properties).sort()).toEqual(['code', 'message', 'name', 'stack']);
      const serialized = JSON.stringify(properties);
      for (const forbidden of [proposed, prior, 'synthetic private audit details', 'parameters', 'cause']) {
        expect(serialized).not.toContain(forbidden);
      }
      expect(await read(agency, label)).toEqual([before]);
      expect(await getIntegrationSecret(database, before.id)).toBe(prior);
      expect(await database.sql`select count(*)::int as count from public.audit_log where target_id=${before.id}`)
        .toEqual([{ count: 1 }]);
    } finally {
      await database.sql`drop trigger reject_integration_audit on public.audit_log`;
      await database.sql`drop function public.reject_integration_audit()`;
    }
  });

  it('restores an existing SQL role and every prior claim after both success and denied membership', async () => {
    const pool = createDb({ connectionString: database.connectionString, max: 1 });
    try {
      const priorClaims = JSON.stringify({ role: 'service_role', sub: agencies[2]!.userId, marker: 'synthetic preserved claims' });
      await pool.sql`select set_config('role','service_role',false), set_config('request.jwt.claims',${priorClaims},false),
        set_config('request.jwt.claim.sub', ${agencies[2]!.userId}, false),
        set_config('request.jwt.claim.role','service_role',false)`;
      const snapshot = () => pool.sql`select current_setting('role') as role,current_setting('request.jwt.claims',true) as claims,
        current_setting('request.jwt.claim.sub',true) as subject,current_setting('request.jwt.claim.role',true) as claim_role`;
      const before = await snapshot();
      await connect(pool, agencies[0]!, { provider: 'keepa', label: randomUUID() }, value());
      expect(await snapshot()).toEqual(before);
      await expect(connect(pool, { orgId: agencies[0]!.orgId, userId: agencies[2]!.userId },
        { provider: 'keepa', label: randomUUID() }, value())).rejects.toBeInstanceOf(AgencyAccessDenied);
      expect(await snapshot()).toEqual(before);
    } finally { await pool.close(); }
  });

  it('keeps recoverable storage service-only and refuses invalid authority instead of returning a storage result', async () => {
    const signature = 'app.try_store_integration_secret(uuid,text)';
    const [acl] = await database.sql`select
      has_function_privilege('anon',${signature},'execute') as anon,
      has_function_privilege('authenticated',${signature},'execute') as authenticated,
      has_function_privilege('service_role',${signature},'execute') as service,
      (select prosecdef from pg_proc where oid=${signature}::regprocedure) as definer`;
    expect(acl).toEqual({ anon: false, authenticated: false, service: true, definer: false });
    await expect(withAuthenticatedIdentity(database, { userId: agencies[0]!.userId }, async (sql) => {
      await sql`select app.try_store_integration_secret(${randomUUID()},${value()})`;
    })).rejects.toMatchObject({ code: '42501' });
    await expect(database.sql.begin(async (sql) => {
      await sql`set local role service_role`;
      await sql`select set_config('request.jwt.claims','{"role":"authenticated"}',true),
        set_config('request.jwt.claim.role','authenticated',true)`;
      await sql`select app.try_store_integration_secret(${randomUUID()},${value()})`;
    })).rejects.toMatchObject({ code: '42501' });
  });

  it('survives backend loss during the actual SQL store with one uncertain outcome and no new metadata or audit', async () => {
    const agency = agencies[0]!; const label = randomUUID(); const proposed = value();
    const pool = createDb({ connectionString: database.connectionString, max: 1 });
    await database.sql`create function public.hold_integration_activation() returns trigger language plpgsql as $$
      begin if new.status='active' then perform pg_sleep(10); end if; return new; end $$`;
    await database.sql`create trigger hold_integration_activation before update on public.integration_connections
      for each row execute function public.hold_integration_activation()`;
    try {
      const [backend] = await pool.sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
      const before = await database.sql`select count(*)::int as count from public.audit_log`;
      const outcome = connect(pool, agency, { provider: 'keepa', label }, proposed)
        .then(() => null, (error: unknown) => error);
      let sleeping = false;
      for (let i = 0; i < 200; i++) {
        const rows = await database.sql`select pid from pg_stat_activity where pid=${backend!.pid}
          and datname=current_database() and wait_event='PgSleep'
          and position('app.try_store_integration_secret' in query)>0`;
        if (rows.length === 1) { sleeping = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(sleeping).toBe(true);
      expect(await database.sql`select pg_terminate_backend(${backend!.pid}) as terminated`).toEqual([{ terminated: true }]);
      const error = await outcome;
      expect(error).toBeInstanceOf(IntegrationCredentialCommandError);
      expect(JSON.stringify(Object.getOwnPropertyDescriptors(error))).not.toContain(proposed);
      expect(await read(agency, label)).toHaveLength(0);
      expect(await database.sql`select count(*)::int as count from public.audit_log`).toEqual(before);
      // A later independent request may reconnect; the lost transaction itself
      // must not enqueue rollback or other SQL onto that replacement session.
      expect(await pool.sql`select 1::int as healthy`).toEqual([{ healthy: 1 }]);
      expect(await pool.sql.begin(async (sql) => (await sql`select 2::int as healthy`)[0]?.healthy)).toBe(2);
    } finally {
      await pool.close();
      await database.sql`drop trigger hold_integration_activation on public.integration_connections`;
      await database.sql`drop function public.hold_integration_activation()`;
    }
  });

  it('serializes current membership changes against the actual credential transaction in both orders', async () => {
    const agency = agencies[0]!;
    const wait = async (fragment: string) => {
      for (let i = 0; i < 200; i++) {
        const rows = await database.sql`select pid from pg_stat_activity where datname=current_database()
          and wait_event_type='Lock' and position(${fragment} in query)>0`;
        if (rows.length) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error('Expected authority operation to wait');
    };
    for (const order of ['membership', 'credential'] as const) {
      const userId = randomUUID(); const actor = { orgId: agency.orgId, userId }; const label = randomUUID();
      await database.sql`insert into auth.users(id) values(${userId})`;
      await database.sql`insert into public.org_members(org_id,user_id,role) values(${agency.orgId},${userId},'admin')`;
      const connection = await createIntegrationConnection(database, { orgId: agency.orgId, provider: 'keepa', label });
      let release!: () => void; let acquired!: () => void;
      const hold = new Promise<void>((resolve) => { release = resolve; });
      const ready = new Promise<void>((resolve) => { acquired = resolve; });
      const blocker = database.sql.begin(async (sql) => {
        if (order === 'membership') await sql`update public.org_members set role='analyst' where org_id=${actor.orgId} and user_id=${userId}`;
        else await sql`select id from public.integration_connections where id=${connection.id} for update`;
        acquired(); await hold;
      });
      await ready;
      const changing = connect(database, actor, { provider: 'keepa', label }, value());
      const result = changing.then(() => 'stored', (error: unknown) => {
        expect(error).toBeInstanceOf(AgencyAccessDenied); return 'denied';
      });
      let downgrade: Promise<unknown> | undefined;
      try {
        await wait(order === 'membership' ? 'app.lock_org_editor' : 'insert into public.integration_connections');
        if (order === 'credential') {
          downgrade = database.sql`update public.org_members set role='analyst' where org_id=${actor.orgId} and user_id=${userId}`.execute();
          await wait("set role='analyst'");
        }
      } finally { release(); }
      await blocker;
      expect(await result).toBe(order === 'membership' ? 'denied' : 'stored');
      await downgrade;
      expect((await read(actor, label))[0]?.status).toBe(order === 'membership' ? 'pending' : 'active');
      await expect(revoke(database, actor, connection.id)).rejects.toBeInstanceOf(AgencyAccessDenied);
    }
  });
});
