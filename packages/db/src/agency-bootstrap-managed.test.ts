import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable, type TestDatabase } from './testing/harness.js';
import { asServiceRole } from './testing/rls.js';
import { acceptAgencyBootstrapInvitation } from './queries/agency-bootstrap.js';
import { provisionAgency } from './operator.js';

const available = await databaseAvailable();
describe.skipIf(!available)('bootstrap managed migration owner', () => {
  let database: TestDatabase;
  let migration: string;
  beforeAll(async () => {
    database = await createTestDatabase('bootstrap_managed', { throughMigration: '20260907040000_mcp_read_authority.sql' });
    migration = await readFile(new URL('../../../supabase/migrations/20260907050000_agency_bootstrap_invitations.sql', import.meta.url), 'utf8');
    // All grants and ownership changes belong to this disposable database.
    // The existing test role's cluster attributes/memberships stay untouched.
    await database.sql`grant usage,create on schema app,public to supabase_admin`;
    await database.sql`grant usage on schema auth to supabase_admin`;
    await database.sql`grant select,references on auth.users to supabase_admin`;
    for (const table of ['orgs', 'org_members', 'audit_log']) {
      await database.sql.unsafe(`alter table public.${table} owner to supabase_admin`);
    }
    await database.sql`alter default privileges for role supabase_admin in schema app grant all on tables to anon,authenticated,service_role`;
    await database.sql`alter default privileges for role supabase_admin in schema app grant execute on functions to anon,authenticated,service_role`;
  }, 60_000);
  afterAll(async () => { await database?.drop(); });

  it('refuses missing Auth row-lock privileges before creating application objects', async () => {
    await expect(database.sql.begin(async (sql) => {
      await sql`set local role supabase_admin`;
      await sql.unsafe(migration);
    })).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('row-lock permission') });
    const [row] = await database.sql`select to_regclass('app.agency_bootstrap_invitations') as ledger`;
    expect(row!.ledger).toBeNull();
  });

  it('accepts with only UPDATE(id) for locking and closes broad creator defaults', async () => {
    await database.sql`grant update(id) on auth.users to supabase_admin`;
    await database.sql.begin(async (sql) => {
      await sql`set local role supabase_admin`;
      await sql.unsafe(migration);
    });
    const raw = randomBytes(32).toString('base64url');
    const email = `${randomUUID()}@example.test`;
    const token = { tokenHash: createHash('sha256').update(raw).digest('hex'), tokenPrefix: raw.slice(0, 12) };
    const receipt = await asServiceRole(database, (sql) => provisionAgency({ sql }, {
      requestId: randomUUID(), name: 'Synthetic managed agency', slug: `managed-${randomUUID()}`, ownerEmail: email, token,
    }));
    const userId = randomUUID();
    await database.sql`insert into auth.users(id,email,email_confirmed_at) values (${userId},${email},now())`;
    expect(await acceptAgencyBootstrapInvitation(database, { userId }, token.tokenHash)).toMatchObject({ orgId: receipt.orgId, outcome: 'accepted' });
    const [grants] = await database.sql`
      select has_column_privilege('supabase_admin','auth.users','id','UPDATE') as owner_row_lock,
             has_column_privilege('supabase_admin','auth.users','email','UPDATE') as owner_email_update,
             has_any_column_privilege('authenticated','auth.users','UPDATE') as browser_auth_update,
             has_table_privilege('service_role','app.agency_bootstrap_invitations','SELECT') as service_ledger_read,
             has_table_privilege('authenticated','app.agency_bootstrap_invitations','INSERT') as browser_ledger_write,
             has_function_privilege('authenticated','app.provision_agency(uuid,text,text,text,text,text)','EXECUTE') as browser_provision,
             has_function_privilege('service_role','app.accept_bootstrap_invitation(text)','EXECUTE') as service_accept
    `;
    expect(grants).toEqual({ owner_row_lock: true, owner_email_update: false, browser_auth_update: false, service_ledger_read: false, browser_ledger_write: false, browser_provision: false, service_accept: false });
    const [role] = await database.sql`select rolsuper,rolbypassrls,rolcanlogin from pg_roles where rolname='supabase_admin'`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false, rolcanlogin: false });
  });
});
