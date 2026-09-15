import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';

const cookie = vi.hoisted(() => ({ orgId: null as string | null, reads: 0 }));
vi.mock('next/headers', () => ({
  cookies: async () => {
    cookie.reads += 1;
    return { get: () => cookie.orgId === null ? undefined : { value: cookie.orgId } };
  },
}));

import { listMemberships, resolveOrgContext } from './orgs';

const available = await databaseAvailable();
const USER_A = '51515151-5151-4151-8151-515151515151';
const USER_B = '62626262-6262-4262-8262-626262626262';
const USER_NONE = '73737373-7373-4373-8373-737373737373';

describe.skipIf(!available)('agency selection under current-user RLS', () => {
  let database: TestDatabase;
  let orgA: string;
  let orgB: string;

  beforeAll(async () => {
    database = await createTestDatabase('org_selection');
    const [row] = await database.sql<{ a: string; b: string }[]>`
      select app.seed_tenant_fixture('org-choice-a', ${USER_A}, 'owner') as a,
             app.seed_tenant_fixture('org-choice-b', ${USER_B}, 'owner') as b
    `;
    orgA = row!.a; orgB = row!.b;
  }, 60_000);

  beforeEach(() => { cookie.orgId = null; cookie.reads = 0; });
  afterAll(async () => { await database?.drop(); });

  it('lists only the verified identity memberships and grants no fallback membership', async () => {
    expect((await listMemberships(database, USER_A)).map((m) => m.orgId)).toEqual([orgA]);
    expect((await listMemberships(database, USER_B)).map((m) => m.orgId)).toEqual([orgB]);
    expect(await listMemberships(database, USER_NONE)).toEqual([]);
  });

  it('refuses a foreign explicit org even when the cookie names a valid own org', async () => {
    cookie.orgId = orgA;
    const context = await resolveOrgContext(database, { id: USER_A, email: null }, orgB);
    expect(context.active).toBeNull();
    expect(context.memberships.map((m) => m.orgId)).toEqual([orgA]);
    expect(cookie.reads).toBe(0);
  });

  it('does not reinterpret an empty explicit selection as navigation fallback', async () => {
    const context = await resolveOrgContext(database, { id: USER_A, email: null }, '');
    expect(context.active).toBeNull();
    expect(cookie.reads).toBe(0);
  });

  it('retains ordinary shell fallback only when no operation org was supplied', async () => {
    cookie.orgId = orgB;
    const context = await resolveOrgContext(database, { id: USER_A, email: null });
    expect(context.active?.orgId).toBe(orgA);
    expect(cookie.reads).toBe(1);
  });

  it('selects the explicit membership for a user intentionally in two agencies', async () => {
    await database.sql`insert into public.org_members(org_id,user_id,role) values (${orgB},${USER_A},'viewer')`;
    try {
      cookie.orgId = orgA;
      const context = await resolveOrgContext(database, { id: USER_A, email: null }, orgB);
      expect(context.active?.orgId).toBe(orgB);
      expect(context.active?.role).toBe('viewer');
      expect(context.memberships).toHaveLength(2);
    } finally {
      await database.sql`delete from public.org_members where org_id = ${orgB} and user_id = ${USER_A}`;
    }
    const revoked = await resolveOrgContext(database, { id: USER_A, email: null }, orgB);
    expect(revoked.active).toBeNull();
  });
});
