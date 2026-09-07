import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import { GET as bids } from '../app/api/bid-history/route';
import { GET as experiments } from '../app/api/experiments/route';
import { GET as experiment } from '../app/api/experiments/[experimentId]/route';
import { GET as options } from '../app/api/experiments/scope-options/route';
import { GET as feedback } from '../app/api/feedback/route';
import { GET as item } from '../app/api/feedback/[itemId]/route';
import { GET as similar } from '../app/api/feedback/similar/route';
import { GET as groups } from '../app/api/optimizer/groups/route';
import { authenticatedRead } from './server/authenticated-read';

const available = await databaseAvailable();
const bridge = 'synthetic-agency-api-read-bridge';
const date = '2026-08-29';
const kinds = ['bids', 'experiments', 'experiment', 'options', 'feedback', 'item', 'similar', 'groups'] as const;
type Kind = typeof kinds[number];
interface Agency { orgId: string; userId: string; profileId: string; experimentId: string; itemId: string; marker: string }

describe.skipIf(!available)('agency API reads', () => {
  let database: TestDatabase;
  const agencies: Agency[] = [];
  const names = ['DATABASE_URL', 'WIZARD_ADS_E2E_AUTH_BRIDGE', 'WIZARD_ADS_AUTH_BRIDGE_SECRET'] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  beforeAll(async () => {
    database = await createTestDatabase('agency_api_reads');
    for (const marker of ['Synthetic API alpha', 'Synthetic API bravo', 'Synthetic API staff']) {
      const userId = randomUUID();
      const [org] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture(${randomUUID()},${userId},'owner',${date}) as id`;
      const orgId = org!.id;
      const [profile] = await database.sql<{ id: string }[]>`select id from public.ad_profiles where org_id=${orgId}`;
      const [exp] = await database.sql<{ id: string }[]>`update public.experiments set name=${marker} where org_id=${orgId} returning id`;
      const [bug] = await database.sql<{ id: string }[]>`update public.feedback_items set title=${marker} where org_id=${orgId} returning id`;
      await database.sql`update public.campaigns set name=${marker} where org_id=${orgId}`;
      await database.sql`update public.optimization_groups set name=${marker} where org_id=${orgId}`;
      agencies.push({ orgId, userId, profileId: profile!.id, experimentId: exp!.id, itemId: bug!.id, marker });
    }
    process.env['DATABASE_URL'] = database.connectionString;
    process.env['WIZARD_ADS_E2E_AUTH_BRIDGE'] = '1';
    process.env['WIZARD_ADS_AUTH_BRIDGE_SECRET'] = bridge;
  }, 60_000);
  afterAll(async () => {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    await database?.drop();
  });
  function request(path: string, actor: Agency, orgId = actor.orgId): Request {
    return new Request('http://localhost' + path, { headers: {
      'x-wizard-ads-auth-bridge': bridge, 'x-wizard-ads-user-id': actor.userId, 'x-wizard-ads-org-id': orgId,
      'if-none-match': '"previous-agency"',
    } });
  }
  function read(kind: Kind, actor: Agency, target: Agency, orgId = actor.orgId): Promise<Response> {
    if (kind === 'bids') {
      const query = new URLSearchParams({ profile: target.profileId, target: 'kw-1', from: date, to: date });
      return bids(request(`/api/bid-history?${query}`, actor, orgId));
    }
    if (kind === 'experiments') return experiments(request(`/api/experiments?profile=${target.profileId}`, actor, orgId));
    if (kind === 'experiment') return experiment(request(`/api/experiments/${target.experimentId}`, actor, orgId), { params: Promise.resolve({ experimentId: target.experimentId }) });
    if (kind === 'options') return options(request(`/api/experiments/scope-options?profile=${target.profileId}`, actor, orgId));
    if (kind === 'feedback') return feedback(request('/api/feedback?type=bug&sort=votes', actor, orgId));
    if (kind === 'item') return item(request(`/api/feedback/${target.itemId}`, actor, orgId), { params: Promise.resolve({ itemId: target.itemId }) });
    if (kind === 'similar') return similar(request('/api/feedback/similar?q=' + encodeURIComponent(target.marker), actor, orgId));
    return groups(request(`/api/optimizer/groups?profileId=${target.profileId}`, actor, orgId));
  }
  function privateData(response: Response): void {
    expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    expect(response.headers.get('vary')).toBe('Cookie, Authorization');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  }

  it.each(kinds)('%s keeps records, search and counts inside the selected agency', async (kind) => {
    let responses = 0;
    for (const actor of agencies) {
      for (const target of agencies) {
        const response = await read(kind, actor, target);
        privateData(response);
        expect(response.status).toBe(actor === target || kind === 'feedback' || kind === 'similar' ? 200 : 404);
        const text = await response.text();
        for (const other of agencies.filter((agency) => agency !== actor)) expect(text).not.toContain(other.marker);
        if (actor === target) {
          expect(text).toContain(actor.marker);
          const body = JSON.parse(text) as Record<string, unknown>;
          if (kind === 'feedback') expect(body['counts']).toMatchObject({ total: 1, openBugs: 1 });
          if (kind === 'feedback' || kind === 'experiments' || kind === 'similar') expect(body['items']).toHaveLength(1);
          if (kind === 'bids') expect(body['points']).toHaveLength(1);
        }
        if (actor !== target) {
          const forged = await read(kind, actor, target, target.orgId);
          privateData(forged);
          expect(forged.status).toBe(403);
          expect(await forged.json()).toEqual({ error: 'Resource not found' });
        }
        responses += 1;
      }
    }
    expect(responses).toBe(9);
  });

  it('uses authenticated database claims and rechecks a removed membership on the same URLs', async () => {
    const actor = agencies[0]!;
    const identity = await authenticatedRead(request('/api/read-proof', actor), async (handle) => {
      const [row] = await handle.sql`select current_user as role,auth.uid()::text as subject`;
      return Response.json(row);
    });
    expect(await identity.json()).toEqual({ role: 'authenticated', subject: actor.userId });
    await database.sql`delete from public.org_members where org_id=${actor.orgId} and user_id=${actor.userId}`;
    try {
      for (const kind of kinds) {
        const response = await read(kind, actor, actor);
        expect(response.status).toBe(403);
        privateData(response);
      }
    } finally {
      await database.sql`insert into public.org_members(org_id,user_id,role) values(${actor.orgId},${actor.userId},'owner')`;
    }
  });

  it('applies real RLS and redacts a database failure while preserving the next request', async () => {
    const actor = agencies[0]!;
    const marker = 'synthetic-private-detail-' + randomUUID();
    await database.sql.unsafe(`create function public.api_read_test_failure() returns boolean language plpgsql as $$ begin raise exception '${marker}'; end; $$`);
    await database.sql`grant execute on function public.api_read_test_failure() to authenticated`;
    await expect(database.sql`select public.api_read_test_failure()`).rejects.toThrow(marker);
    await database.sql`create policy api_read_test on public.feedback_items as restrictive for select to authenticated using(public.api_read_test_failure())`;
    try {
      for (const kind of ['feedback', 'item', 'similar'] as const) {
        const response = await read(kind, actor, actor);
        expect(response.status).toBe(503);
        privateData(response);
        expect(await response.json()).toEqual({ error: 'Could not load this data. Try again.' });
      }
    } finally {
      await database.sql`drop policy api_read_test on public.feedback_items`;
      await database.sql`drop function public.api_read_test_failure()`;
    }
    expect((await read('feedback', actor, actor)).status).toBe(200);
  });
});
