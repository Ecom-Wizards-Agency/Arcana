import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import { createGotoLink, stateFromGotoRedirect, type GotoLinkRecord } from '@wizard-ads/db';
import { GET } from '../app/go/[token]/route';
import * as requestContext from './server/request-context';

const available = await databaseAvailable();
const bridge = 'synthetic-goto-route-bridge';
const signingSecret = ['synthetic', 'goto', 'route', 'signing', 'material'].join('-');
const application = 'synthetic-goto-route-' + randomUUID();
interface Agency { orgId: string; userId: string; link: GotoLinkRecord }

describe.skipIf(!available)('agency shared-link route', () => {
  let database: TestDatabase;
  const agencies: Agency[] = [];
  beforeAll(async () => {
    database = await createTestDatabase('goto_agency_route');
    for (let i = 0; i < 3; i++) {
      const userId = randomUUID();
      const [org] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture(${randomUUID()},${userId},'owner') as id`;
      const orgId = org!.id;
      const link = await createGotoLink(database, { orgId, createdBy: userId, signingSecret,
        route: '/tags?view=campaigns', state: { marker: `Synthetic agency ${i}`, nested: [1, null, { value: 'two' }] } });
      agencies.push({ orgId, userId, link });
    }
    const url = new URL(database.connectionString); url.searchParams.set('application_name', application);
    vi.stubEnv('DATABASE_URL', url.toString());
    vi.stubEnv('WIZARD_ADS_E2E_AUTH_BRIDGE', '1');
    vi.stubEnv('WIZARD_ADS_AUTH_BRIDGE_SECRET', bridge);
    vi.stubEnv('GOTO_LINK_SIGNING_SECRET', signingSecret);
  }, 60_000);
  afterAll(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await database?.drop(); });
  async function read(actor: Agency, token = actor.link.token, orgId = actor.orgId): Promise<Response> {
    const response = await GET(new Request('http://localhost/go/' + token, { headers: {
      'x-wizard-ads-auth-bridge': bridge, 'x-wizard-ads-user-id': actor.userId, 'x-wizard-ads-org-id': orgId,
      'if-none-match': '"previous-agency"',
    } }), { params: Promise.resolve({ token }) });
    expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    expect(response.headers.get('vary')).toBe('Cookie, Authorization');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await database.sql`select pid from pg_stat_activity where datname=current_database() and application_name=${application}`).toEqual([]);
    if (response.status === 404) {
      expect(response.headers.get('location')).toBeNull();
      expect(await response.clone().text()).toBe('Not found');
    }
    return response;
  }
  async function visits(link: GotoLinkRecord): Promise<number> {
    const rows = await database.sql<{ uses: number }[]>`select uses from public.goto_links where id=${link.id}`;
    expect(rows).toHaveLength(1); return rows[0]!.uses;
  }

  it('returns exact internal state only for the owning agency and counts each visit once', async () => {
    let responses = 0;
    for (const actor of agencies) {
      const before = await visits(actor.link);
      const response = await read(actor); responses++;
      expect(response.status).toBe(307);
      const location = response.headers.get('location')!;
      expect(new URL(location).origin).toBe('http://localhost');
      expect(new URL(location).pathname).toBe('/tags');
      expect(stateFromGotoRedirect(location)).toEqual(actor.link.state);
      for (const other of agencies.filter((candidate) => candidate !== actor)) {
        expect((await read(actor, other.link.token)).status).toBe(404); responses++;
        expect((await read(actor, other.link.token, other.orgId)).status).toBe(404); responses++;
      }
      expect(await visits(actor.link)).toBe(before + 1);
    }
    expect(responses).toBe(15);
  });

  it('preserves selected-agency viewer navigation and refuses the next request after removal', async () => {
    const actor = agencies[0]!; const selected = agencies[1]!;
    const before = await visits(selected.link);
    await database.sql`insert into public.org_members(org_id,user_id,role) values(${selected.orgId},${actor.userId},'viewer')`;
    try {
      expect((await read(actor, selected.link.token, selected.orgId)).status).toBe(307);
      expect((await read(actor, selected.link.token)).status).toBe(404);
    } finally { await database.sql`delete from public.org_members where org_id=${selected.orgId} and user_id=${actor.userId}`; }
    expect((await read(actor, selected.link.token, selected.orgId)).status).toBe(404);
    expect(await visits(selected.link)).toBe(before + 1);
  });

  it('keeps malformed, expired, hidden and database-failed returns uniformly private without counting', async () => {
    const actor = agencies[0]!; const before = await visits(actor.link);
    expect((await read(actor, actor.link.token + 'x')).status).toBe(404);
    const expired = await createGotoLink(database, { orgId: actor.orgId, route: '/tags', state: null,
      signingSecret, expiresAt: new Date('2020-01-01T00:00:00Z') });
    expect((await read(actor, expired.token)).status).toBe(404);
    await database.sql`create policy goto_route_hidden on public.goto_links as restrictive for select to authenticated using(false)`;
    try { expect((await read(actor)).status).toBe(404); }
    finally { await database.sql`drop policy goto_route_hidden on public.goto_links`; }
    await database.sql`alter table public.goto_links rename column state to synthetic_hidden_state`;
    try { expect((await read(actor)).status).toBe(404); }
    finally { await database.sql`alter table public.goto_links rename column synthetic_hidden_state to state`; }
    expect(await visits(actor.link)).toBe(before);
    expect(await visits(expired)).toBe(0);
  });

  it('verifies identity and configuration before opening a connection', async () => {
    const identify = vi.spyOn(requestContext, 'requestActor').mockRejectedValue(new requestContext.RequestAuthError('Authentication required', 401));
    const open = vi.spyOn(requestContext, 'openWebDatabase');
    try { expect((await read(agencies[0]!)).status).toBe(404); expect(open).not.toHaveBeenCalled(); }
    finally { identify.mockRestore(); open.mockRestore(); }
    vi.stubEnv('GOTO_LINK_SIGNING_SECRET', '');
    const missing = vi.spyOn(requestContext, 'openWebDatabase');
    try { expect((await read(agencies[0]!)).status).toBe(404); expect(missing).not.toHaveBeenCalled(); }
    finally { missing.mockRestore(); vi.stubEnv('GOTO_LINK_SIGNING_SECRET', signingSecret); }
  });

  it('does not redirect or retry after a committed visit whose final close fails', async () => {
    const actor = agencies[0]!; const before = await visits(actor.link);
    const originalOpen = requestContext.openWebDatabase; let closes = 0;
    const open = vi.spyOn(requestContext, 'openWebDatabase').mockImplementation(() => {
      const handle = originalOpen();
      return { ...handle, close: async () => { closes++; await handle.close(); throw new Error('Synthetic private teardown'); } };
    });
    try { expect((await read(actor)).status).toBe(404); expect(closes).toBe(1); }
    finally { open.mockRestore(); }
    expect(await visits(actor.link)).toBe(before + 1);
  });
});
