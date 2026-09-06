import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createDb } from './client.js';
import { adminConnectionString, createTestDatabase, databaseAvailable, type TestDatabase } from './testing/harness.js';

const available = await databaseAvailable();
const migrations = [
  '20260907000000_one_time_rpc_previews.sql',
  '20260907010000_one_time_rpc_runtime.sql',
  '20260907020000_one_time_preview_exports.sql',
] as const;
type SessionSql = Awaited<ReturnType<TestDatabase['sql']['reserve']>>;

async function memberships(sql: SessionSql) {
  return sql`
    select roleid, member, grantor, admin_option, inherit_option, set_option
      from pg_catalog.pg_auth_members
     where roleid in ('openspell_recommendation_executor'::regrole, 'openspell_recommendation_worker'::regrole)
        or member in ('openspell_recommendation_executor'::regrole, 'openspell_recommendation_worker'::regrole)
     order by roleid, member, grantor
  `;
}

async function schemas(sql: SessionSql) {
  return sql`
    select nspname, nspowner, nspacl::text from pg_catalog.pg_namespace
     where nspname in ('app', 'public') order by nspname
  `;
}

async function executorFunctions(sql: SessionSql) {
  return sql<{ signature: string; owner: string; acl: string }[]>`
    select p.oid::regprocedure::text as signature, p.proowner::regrole::text as owner, p.proacl::text as acl
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proowner = 'openspell_recommendation_executor'::regrole
     order by signature
  `;
}

async function state(sql: SessionSql) {
  const [row] = await sql<{ snapshot: unknown }[]>`
    select jsonb_build_object(
      'authority', (select to_jsonb(authority) from app.recommendation_claim_authority authority),
      'runs', (select jsonb_agg(to_jsonb(run) - 'execution_snapshot' order by run.id) from public.recommendation_runs run),
      'batches', (select jsonb_agg(to_jsonb(batch) - 'execution_snapshot' order by batch.id) from public.recommendation_preview_batches batch),
      'recommendations', (select jsonb_agg(to_jsonb(recommendation) order by recommendation.id) from public.recommendations recommendation),
      'jobs', (select jsonb_agg(to_jsonb(job) order by job.id) from public.sync_jobs job)
    ) as snapshot
  `;
  return row!.snapshot;
}

async function transferApplicationOwnership(sql: SessionSql, role: string) {
  // Alter only this disposable database's objects. REASSIGN OWNED can affect other databases.
  const statements = await sql<{ statement: string }[]>`
    select format('alter schema %I owner to %I', nspname, ${role}::text) as statement
      from pg_namespace where nspname in ('app', 'public')
    union all
    select format('alter %s %I.%I owner to %I', case when c.relkind = 'S' then 'sequence'
      when c.relkind = 'v' then 'view' when c.relkind = 'm' then 'materialized view' else 'table' end,
      n.nspname, c.relname, ${role}::text)
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname in ('app', 'public') and c.relkind in ('r','p','S','v','m')
       and c.relowner = current_user::regrole
       and not exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
       and not (c.relkind = 'S' and exists (select 1 from pg_depend d where d.classid = 'pg_class'::regclass
         and d.objid = c.oid and d.refclassid = 'pg_class'::regclass and d.deptype in ('a','i')))
    union all
    select format('alter function %s owner to %I', p.oid::regprocedure, ${role}::text)
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('app', 'public') and p.prokind = 'f' and p.proowner = current_user::regrole
       and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
    union all
    select format('alter type %I.%I owner to %I', n.nspname, t.typname, ${role}::text)
      from pg_type t join pg_namespace n on n.oid = t.typnamespace
     where n.nspname in ('app', 'public') and t.typtype in ('e','d') and t.typowner = current_user::regrole
  `;
  expect(statements.length).toBeGreaterThan(0);
  for (const { statement } of statements) await sql.unsafe(statement);
}

describe.skipIf(!available)('one-time migrations under managed PostgreSQL ownership', () => {
  it('applies the actual files as a non-super owner and restores executor memberships and ACLs', async () => {
    const database = await createTestDatabase('one_time_managed', {
      throughMigration: '20260901060000_recommendation_claim_custody.sql',
    });
    const role = `one_time_migration_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const sql = await database.sql.reserve();
    const originalMemberships = await memberships(sql);
    let createdRole = false;
    try {
      await sql`select app.seed_tenant_fixture('one-time-managed', ${randomUUID()}::uuid, 'owner', date '2026-08-26')`;
      await sql`create role ${sql(role)} nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls`;
      createdRole = true;
      await transferApplicationOwnership(sql, role);
      const beforeState = await state(sql);
      const beforeSchemas = await schemas(sql);
      const beforeFunctions = await executorFunctions(sql);
      expect(beforeFunctions).toHaveLength(8);

      for (const migration of migrations) {
        const source = await readFile(new URL(`../../../supabase/migrations/${migration}`, import.meta.url), 'utf8');
        await sql`begin`;
        try {
          // This ADMIN-only fixture edge is never committed. Parallel test databases cannot see it.
          await sql`grant openspell_recommendation_executor to ${sql(role)}
            with admin true, inherit false, set false granted by current_user`;
          const beforeMemberships = await memberships(sql);
          await sql`set session authorization ${sql(role)}`;
          const [principal] = await sql<{
            original_session: boolean; rolsuper: boolean; rolcreaterole: boolean; rolinherit: boolean; rolbypassrls: boolean;
          }[]>`
            select current_user = session_user as original_session, rolsuper, rolcreaterole, rolinherit, rolbypassrls
              from pg_roles where rolname = current_user
          `;
          expect(principal).toEqual({ original_session: true, rolsuper: false, rolcreaterole: false,
            rolinherit: false, rolbypassrls: false });
          // No text rewriting, grant wrapper, or mocked SQL: the deployable migration owns its envelope.
          await sql.unsafe(source);
          expect(await memberships(sql)).toEqual(beforeMemberships);
          expect(await schemas(sql)).toEqual(beforeSchemas);
          expect((await executorFunctions(sql)).filter(row => !row.signature.startsWith('report_recommendation_runtime(')))
            .toEqual(beforeFunctions);
          expect(await state(sql)).toEqual(beforeState);
          await sql`reset session authorization`;
          await sql`revoke openspell_recommendation_executor from ${sql(role)} granted by current_user`;
          await sql`commit`;
        } catch (error) {
          await sql`rollback`;
          await sql`reset session authorization`;
          throw error;
        }
      }

      expect(await state(sql)).toEqual(beforeState);
      expect(await memberships(sql)).toEqual(originalMemberships);
      expect(await executorFunctions(sql)).toHaveLength(9);
      const [reporter] = await sql`
        select p.proowner::regrole::text as owner,
          has_function_privilege('openspell_recommendation_worker', p.oid, 'execute') as worker_execute,
          has_function_privilege('anon', p.oid, 'execute') as anon_execute,
          has_function_privilege('authenticated', p.oid, 'execute') as authenticated_execute,
          has_function_privilege('service_role', p.oid, 'execute') as service_execute,
          has_schema_privilege('openspell_recommendation_executor', 'public', 'create') as schema_create
        from pg_proc p where p.oid = 'public.report_recommendation_runtime(text,text,integer[],boolean)'::regprocedure
      `;
      expect(reporter).toEqual({ owner: 'openspell_recommendation_executor', worker_execute: true,
        anon_execute: false, authenticated_execute: false, service_execute: false, schema_create: false });
      const helperOwners = await sql<{ owner: string }[]>`
        select distinct p.proowner::regrole::text as owner from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where (n.nspname = 'app' and p.proname in ('one_time_rpc_snapshot_valid', 'one_time_rpc_snapshot_fingerprint',
           'guard_one_time_rpc_snapshot', 'recommendation_campaign_safety', 'one_time_recommendation_worker_ready',
           'guard_one_time_recommendation_admission', 'guard_one_time_preview_export'))
           or (n.nspname = 'public' and p.proname = 'get_one_time_recommendation_readiness')
      `;
      expect(helperOwners).toEqual([{ owner: role }]);
      expect(await sql`select count(*)::integer as count from app.recommendation_runtime_state`).toEqual([{ count: 0 }]);
    } finally {
      await sql`rollback`.catch(() => {});
      await sql`reset session authorization`.catch(() => {});
      sql.release();
      await database.drop();
      if (createdRole) {
        const admin = createDb({ connectionString: adminConnectionString(), max: 1 });
        try { await admin.sql`drop role ${admin.sql(role)}`; }
        finally { await admin.close(); }
      }
    }
  }, 60_000);
});
