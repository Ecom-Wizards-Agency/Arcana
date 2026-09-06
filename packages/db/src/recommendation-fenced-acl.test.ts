import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDatabase, databaseAvailable, type TestDatabase,
} from './testing/harness.js';

const available = await databaseAvailable();
const repair = await readFile(fileURLToPath(new URL(
  '../../../supabase/migrations/20260906050000_recommendation_fenced_function_acl.sql',
  import.meta.url,
)), 'utf8');
const operator = 'synthetic_recommendation_acl_migrator';
const names = [
  'claim_recommendation_jobs_fenced', 'defer_recommendation_job_fenced',
  'fail_recommendation_run_fenced', 'finish_recommendation_job_fenced',
  'read_recommendation_inputs_fenced', 'resume_recommendation_jobs_fenced',
  'start_recommendation_run_fenced', 'succeed_recommendation_run_fenced',
];

describe.skipIf(!available)('managed recommendation function ACL repair', () => {
  let database: TestDatabase;
  let sql: ReturnType<typeof postgres>;
  const notices: string[] = [];

  beforeAll(async () => {
    database = await createTestDatabase('recommendation_acl_repair', {
      throughMigration: '20260901060000_recommendation_claim_custody.sql',
      applyFixture: false,
    });
    sql = postgres(database.connectionString, {
      max: 1, onnotice: (notice) => { notices.push(notice.message ?? 'unnamed database notice'); },
    });
    await sql.unsafe(`create role ${operator} nologin noinherit nosuperuser nocreatedb
      createrole noreplication nobypassrls`);
    // The hosted migration principal owns app and can create migration helpers.
    await sql.unsafe(`grant usage, create on schema app to ${operator}`);
    // Reproduce the observed hosted ACL, including the missing worker grant.
    const functions = await sql`select p.oid::regprocedure::text as signature
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname=any(${names}::text[])`;
    expect(functions).toHaveLength(8);
    await sql`begin`;
    await sql`set local role openspell_recommendation_executor`;
    for (const fn of functions) {
      await sql.unsafe(`grant execute on function ${fn['signature']}
        to public, anon, authenticated, service_role`);
      await sql.unsafe(`revoke execute on function ${fn['signature']}
        from openspell_recommendation_worker`);
    }
    await sql`commit`;
  }, 180_000);

  afterAll(async () => {
    if (sql !== undefined) {
      await sql`rollback`;
      await sql`reset session authorization`;
      await sql.unsafe(`revoke all on schema app from ${operator}`);
      await sql.unsafe(`drop role if exists ${operator}`);
      await sql.end();
    }
    await database?.drop();
  });

  async function snapshot() {
    const [state] = await sql`select
      (select jsonb_agg(to_jsonb(p) order by p.oid) from pg_proc p
        join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname=any(${names}::text[])) as functions,
      (select coalesce(jsonb_agg(to_jsonb(m) order by m.roleid,m.member,m.grantor),'[]'::jsonb)
        from pg_auth_members m where m.roleid in (
          'openspell_recommendation_worker'::regrole,
          'openspell_recommendation_executor'::regrole)) as memberships`;
    return state;
  }

  async function asManagedRepair() {
    await sql.unsafe(`set session authorization ${operator}`);
    try {
      const [identity] = await sql`select current_user, session_user,
        (select rolsuper from pg_roles where rolname=current_user) as superuser,
        pg_has_role(current_user,'openspell_recommendation_executor','SET') as may_set`;
      expect(identity).toEqual({ current_user: operator, session_user: operator,
        superuser: false, may_set: false });
      return await sql.unsafe(repair);
    } finally {
      await sql`reset session authorization`;
    }
  }

  it('refuses CREATEROLE without existing owner ADMIN authority and changes nothing', async () => {
    const before = await snapshot();
    await expect(asManagedRepair()).rejects.toThrow('needs existing executor ADMIN authority');
    expect(await snapshot()).toEqual(before);
  });

  it('repairs all eight exact ACLs under a non-superuser and restores the ADMIN-only edges', async () => {
    await sql.unsafe(`grant openspell_recommendation_executor, openspell_recommendation_worker
      to ${operator} with admin true, inherit false, set false granted by current_user`);
    const before = await snapshot();
    notices.length = 0;
    await asManagedRepair();
    expect(notices).toEqual([]);
    const after = await snapshot();
    expect(after?.['memberships']).toEqual(before?.['memberships']);
    expect(await sql`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='app' and p.proname=any(${[
        'repair_recommendation_acl_preflight', 'repair_recommendation_acl_apply',
        'repair_recommendation_acl_postflight',
      ]}::text[])`).toHaveLength(0);
    const matrix = await sql`select p.proname as name,
      has_function_privilege('anon',p.oid,'EXECUTE') as anon,
      has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated,
      has_function_privilege('service_role',p.oid,'EXECUTE') as service,
      has_function_privilege('openspell_recommendation_worker',p.oid,'EXECUTE') as worker,
      (select jsonb_agg(jsonb_build_object('grantee',pg_get_userbyid(a.grantee),
        'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable)
        order by pg_get_userbyid(a.grantee)) from aclexplode(p.proacl) a) as acl
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname=any(${names}::text[]) order by p.proname`;
    expect(matrix).toEqual(names.toSorted().map((name) => ({
      name, anon: false, authenticated: false, service: false, worker: true,
      acl: ['openspell_recommendation_executor','openspell_recommendation_worker'].map((grantee) => ({
        grantee, grantor: 'openspell_recommendation_executor', privilege: 'EXECUTE', grantable: false,
      })),
    })));
    // Execute a real public RPC: refusal must occur at its ACL, before its inner guard.
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await sql.unsafe(`set role ${role}`);
      try {
        await expect(sql`select * from public.claim_recommendation_jobs_fenced('synthetic','synthetic',1)`)
          .rejects.toMatchObject({ code: '42501', message: 'permission denied for function claim_recommendation_jobs_fenced' });
      } finally { await sql`reset role`; }
    }
    await sql`set session authorization openspell_recommendation_worker`;
    try {
      // The worker reaches the authority guard; the repair never activates custody.
      await expect(sql`select * from public.claim_recommendation_jobs_fenced('synthetic',${'a'.repeat(40)},1)`)
        .rejects.toMatchObject({ code: '55000', message: 'recommendation fenced claim authority does not match this worker' });
    } finally { await sql`reset session authorization`; }
  });

  it('is idempotent without weakening the sealed roles or changing function bodies', async () => {
    const before = await snapshot();
    notices.length = 0;
    await asManagedRepair();
    expect(notices).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it('rolls back both ACL edits and temporary authority on a postflight failure', async () => {
    await sql`grant execute on function public.resume_recommendation_jobs_fenced(text,text) to postgres`;
    const before = await snapshot();
    await expect(asManagedRepair()).rejects.toThrow('ACL repair postflight failed');
    expect(await snapshot()).toEqual(before);
  });
});
