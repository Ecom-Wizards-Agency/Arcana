import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, type DbHandle } from '../client.js';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '../testing/harness.js';
import { AgencyAccessDenied, withAuthenticatedActor, withAuthenticatedIdentity } from './authenticated-actor.js';

const available = await databaseAvailable();
const USER_A = '10101010-1010-4010-8010-101010101010';
const USER_B = '20202020-2020-4020-8020-202020202020';
const STAFF = '30303030-3030-4030-8030-303030303030';
const NO_MEMBERSHIP = '40404040-4040-4040-8040-404040404040';

describe.skipIf(!available)('authenticated agency transactions', () => {
  let database: TestDatabase;
  let connection: DbHandle;
  let orgA: string;
  let orgB: string;
  let staffOrg: string;

  beforeAll(async () => {
    database = await createTestDatabase('agency_actor');
    const [row] = await database.sql<{ a: string; b: string; staff: string }[]>`
      select app.seed_tenant_fixture('actor-a', ${USER_A}, 'owner') as a,
             app.seed_tenant_fixture('actor-b', ${USER_B}, 'admin') as b,
             app.seed_tenant_fixture('actor-staff', ${STAFF}, 'owner') as staff
    `;
    orgA = row!.a; orgB = row!.b; staffOrg = row!.staff;
    connection = createDb({ connectionString: database.connectionString, max: 1 });
  }, 60_000);

  afterAll(async () => {
    await connection?.close();
    await database?.drop();
  });

  async function identityOutside() {
    const [row] = await connection.sql`
      select current_user::text as role, auth.uid()::text as subject,
             nullif(current_setting('request.jwt.claims', true), '') as claims,
             nullif(current_setting('request.jwt.claim.sub', true), '') as scalar_subject,
             nullif(current_setting('request.jwt.claim.role', true), '') as scalar_role
    `;
    return row;
  }

  it('uses current-user RLS for two agencies and unrelated staff, restoring pool state', async () => {
    const before = await identityOutside();
    const actors = [
      { userId: USER_A, orgId: orgA },
      { userId: USER_B, orgId: orgB },
      { userId: STAFF, orgId: staffOrg },
    ];
    for (const actor of actors) {
      const result = await withAuthenticatedActor(connection, actor, async (sql) => {
        const [row] = await sql`
          select current_user::text as role, auth.uid()::text as subject,
                 (select array_agg(distinct org_id::text) from public.ad_profiles) as visible_orgs
        `;
        return row;
      });
      expect(result).toEqual({ role: 'authenticated', subject: actor.userId, visible_orgs: [actor.orgId] });
      expect(await identityOutside()).toEqual(before);
    }
  });

  it('rejects wrong or removed explicit membership before running a caller query', async () => {
    for (const actor of [
      { userId: USER_A, orgId: orgB },
      { userId: STAFF, orgId: orgA },
      { userId: NO_MEMBERSHIP, orgId: orgA },
    ]) {
      const operation = vi.fn();
      await expect(withAuthenticatedActor(connection, actor, operation)).rejects.toBeInstanceOf(AgencyAccessDenied);
      expect(operation).not.toHaveBeenCalled();
    }
  });

  it('supports verified pre-membership identity without granting another agency', async () => {
    const rows = await withAuthenticatedIdentity(connection, { userId: NO_MEMBERSHIP }, async (sql) =>
      sql`select id from public.orgs`);
    expect(rows).toHaveLength(0);
  });

  it('does not reuse an earlier membership after a concurrent revocation', async () => {
    await database.sql`insert into public.org_members(org_id, user_id, role) values (${orgA}, ${USER_B}, 'viewer')`;
    const rows = await withAuthenticatedActor(connection, { orgId: orgA, userId: USER_B }, async (sql) => {
      await database.sql`delete from public.org_members where org_id = ${orgA} and user_id = ${USER_B}`;
      return sql`select id from public.ad_profiles where org_id = ${orgA}`;
    });
    expect(rows).toHaveLength(0);
    const operation = vi.fn();
    await expect(withAuthenticatedActor(connection, { orgId: orgA, userId: USER_B }, operation))
      .rejects.toBeInstanceOf(AgencyAccessDenied);
    expect(operation).not.toHaveBeenCalled();
  });

  it('keeps a deliberately multi-agency user scoped by the operation predicate', async () => {
    await database.sql`insert into public.org_members(org_id, user_id, role) values (${orgB}, ${USER_A}, 'viewer')`;
    try {
      const rows = await withAuthenticatedActor(connection, { orgId: orgB, userId: USER_A }, async (sql) =>
        sql<{ org_id: string }[]>`select org_id from public.ad_profiles where org_id = ${orgB}`);
      expect(rows.length).toBeGreaterThan(0);
      expect(new Set(rows.map((row) => row.org_id))).toEqual(new Set([orgB]));
    } finally {
      await database.sql`delete from public.org_members where org_id = ${orgB} and user_id = ${USER_A}`;
    }
  });

  it('replaces both modern and scalar claims and restores pre-existing settings', async () => {
    await connection.sql`
      select set_config('request.jwt.claims', ${JSON.stringify({ sub: USER_B, role: 'service_role' })}, false),
             set_config('request.jwt.claim.sub', ${USER_B}, false),
             set_config('request.jwt.claim.role', 'service_role', false)
    `;
    const before = await identityOutside();
    try {
      const result = await withAuthenticatedActor(connection, { orgId: orgA, userId: USER_A }, async (sql) => {
        const [row] = await sql`
          select auth.uid()::text as subject, current_setting('request.jwt.claim.sub') as scalar_subject,
                 current_setting('request.jwt.claim.role') as scalar_role
        `;
        return row;
      });
      expect(result).toEqual({ subject: USER_A, scalar_subject: USER_A, scalar_role: 'authenticated' });
      expect(await identityOutside()).toEqual(before);
    } finally {
      await connection.sql`
        select set_config('request.jwt.claims', '', false),
               set_config('request.jwt.claim.sub', '', false),
               set_config('request.jwt.claim.role', '', false)
      `;
    }
  });

  it('cleans up SQL and callback errors and isolates concurrent requests on one pool', async () => {
    const before = await identityOutside();
    const a = { userId: USER_A, orgId: orgA };
    const b = { userId: USER_B, orgId: orgB };
    await expect(withAuthenticatedActor(connection, a, async (sql) => { await sql`select 1 / 0`; }))
      .rejects.toMatchObject({ code: '22012' });
    await expect(withAuthenticatedActor(connection, a, async () => { throw new Error('synthetic rejection'); }))
      .rejects.toThrow('synthetic rejection');
    const results = await Promise.all([a, b].map((actor) => withAuthenticatedActor(connection, actor, async (sql) => {
      await sql`select pg_sleep(0.01)`;
      const [row] = await sql<{ subject: string }[]>`select auth.uid()::text as subject`;
      return row!.subject;
    })));
    expect(results).toEqual([USER_A, USER_B]);
    expect(await identityOutside()).toEqual(before);
  });

  it('cannot promote an agency owner into privileged queue or audit authority', async () => {
    await expect(withAuthenticatedActor(connection, { orgId: orgA, userId: USER_A }, async (sql) => {
      await sql`insert into public.audit_log(org_id, action, source) values (${orgA}, 'synthetic', 'web')`;
    })).rejects.toMatchObject({ code: '42501' });
  });

  it('rejects malformed actor context before starting the operation', async () => {
    const operation = vi.fn();
    await expect(withAuthenticatedActor(connection, { orgId: orgA, userId: 'invalid' }, operation)).rejects.toThrow();
    expect(operation).not.toHaveBeenCalled();
  });
});
