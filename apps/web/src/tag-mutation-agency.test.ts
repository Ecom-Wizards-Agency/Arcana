import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import { createTag } from '@wizard-ads/db';
import { POST as create } from '../app/api/tags/route';
import { PATCH as update, DELETE as remove } from '../app/api/tags/[tagId]/route';
import { POST as assign, DELETE as unassign } from '../app/api/tags/[tagId]/assign/route';
import { POST as goto } from '../app/api/goto/route';
import { authenticatedMutation } from './server/authenticated-mutation';
import * as requestContext from './server/request-context';

const available = await databaseAvailable();
const bridge = 'synthetic-tag-mutation-bridge';
const signingSecret = ['synthetic', 'tag', 'mutation', 'goto', 'signing'].join('-');
const application = 'synthetic-tag-mutation-' + randomUUID();
const kinds = ['create', 'update', 'detach', 'reassign', 'assign', 'unassign', 'goto'] as const;
type Kind = typeof kinds[number];
interface Agency { orgId: string; userId: string; profileId: string }

describe.skipIf(!available)('agency tag and link mutations', () => {
  let database: TestDatabase;
  const agencies: Agency[] = [];
  beforeAll(async () => {
    database = await createTestDatabase('tag_mutation_agency');
    for (let i = 0; i < 3; i++) {
      const userId = randomUUID();
      const [org] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture(${randomUUID()},${userId},'owner') as id`;
      const [profile] = await database.sql<{ id: string }[]>`select id from public.ad_profiles where org_id=${org!.id}`;
      agencies.push({ userId, orgId: org!.id, profileId: profile!.id });
    }
    const url = new URL(database.connectionString); url.searchParams.set('application_name', application);
    vi.stubEnv('DATABASE_URL', url.toString());
    vi.stubEnv('WIZARD_ADS_E2E_AUTH_BRIDGE', '1');
    vi.stubEnv('WIZARD_ADS_AUTH_BRIDGE_SECRET', bridge);
    vi.stubEnv('GOTO_LINK_SIGNING_SECRET', signingSecret);
  }, 60_000);
  afterAll(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await database?.drop(); });
  function request(kind: Kind, actor: Agency, body: unknown): Request {
    return new Request('http://localhost/api/' + (kind === 'goto' ? 'goto' : 'tags'), {
      method: kind === 'update' ? 'PATCH' : ['detach','reassign','unassign'].includes(kind) ? 'DELETE' : 'POST',
      headers: { 'content-type': 'application/json', 'x-wizard-ads-auth-bridge': bridge,
        'x-wizard-ads-user-id': actor.userId, 'x-wizard-ads-org-id': actor.orgId },
      body: JSON.stringify(body),
    });
  }
  async function call(kind: Kind, actor: Agency, body: unknown, tagId: string = randomUUID()): Promise<Response> {
    const req = request(kind, actor, body); const route = { params: Promise.resolve({ tagId }) };
    const response = await (kind === 'create' ? create(req) : kind === 'goto' ? goto(req) : kind === 'update'
      ? update(req, route) : kind === 'assign' ? assign(req, route) : kind === 'unassign' ? unassign(req, route) : remove(req, route));
    expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    expect(response.headers.get('vary')).toBe('Cookie, Authorization');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await database.sql`select pid from pg_stat_activity where datname=current_database() and application_name=${application}`).toEqual([]);
    return response;
  }
  async function snapshot(exceptOrg?: string) {
    const tags = await database.sql`select * from public.tags where (${exceptOrg ?? null}::uuid is null or org_id<>${exceptOrg ?? null}::uuid) order by id`;
    const assignments = await database.sql`select * from public.entity_tags where (${exceptOrg ?? null}::uuid is null or org_id<>${exceptOrg ?? null}::uuid) order by tag_id,profile_id,entity_id`;
    const links = await database.sql`select * from public.goto_links where (${exceptOrg ?? null}::uuid is null or org_id<>${exceptOrg ?? null}::uuid) order by id`;
    return { tags, assignments, links };
  }
  async function setup(actor: Agency) {
    const source = await createTag(database, { orgId: actor.orgId, name: randomUUID() });
    const target = await createTag(database, { orgId: actor.orgId, name: randomUUID() });
    return { source, target };
  }
  function input(kind: Kind, actor: Agency, targetId: string) {
    if (kind === 'create' || kind === 'update') return { name: randomUUID(), color: 'signal' };
    if (kind === 'goto') return { route: '/tags', state: { synthetic: [1, null, { value: 'two' }] } };
    if (kind === 'detach') return { mode: 'detach' };
    if (kind === 'reassign') return { mode: 'reassign', targetTagId: targetId };
    return { filter: { entityType: 'campaign', profileIds: [actor.profileId], entityIds: ['c-1'] } };
  }

  it.each(kinds)('%s enforces all four current roles across three unrelated agencies', async (kind) => {
    let admitted = 0; let refused = 0;
    for (const actor of agencies) {
      for (const role of ['owner', 'admin', 'analyst', 'viewer'] as const) {
        const { source, target } = await setup(actor);
        if (['detach', 'reassign', 'unassign'].includes(kind)) {
          await database.sql`insert into public.entity_tags(org_id,tag_id,profile_id,entity_type,entity_id)
            values(${actor.orgId},${source.id},${actor.profileId},'campaign','c-1')`;
        }
        await database.sql`update public.org_members set role=${role} where org_id=${actor.orgId} and user_id=${actor.userId}`;
        const before = await snapshot(); const otherBefore = await snapshot(actor.orgId);
        const response = await call(kind, actor, input(kind, actor, target.id), source.id);
        const body = await response.json();
        if (role === 'viewer') {
          expect(response.status).toBe(403); expect(body).toEqual({ error: 'Resource not found' });
          expect(await snapshot()).toEqual(before); refused++;
        } else {
          expect(response.status).toBe(kind === 'create' || kind === 'goto' ? 201 : 200); admitted++;
          expect(await snapshot(actor.orgId)).toEqual(otherBefore);
          if (kind === 'create' || kind === 'update') expect(body.tag).toMatchObject({ orgId: actor.orgId, color: 'signal' });
          if (kind === 'assign') expect(body.result).toEqual({ matchedByFilter: 1, requested: 1, unique: 1, processed: 1, newlyAssigned: 1, skipped: 0 });
          if (kind === 'unassign') expect(body.result).toEqual({ matchedByFilter: 1, requested: 1, unique: 1, removed: 1 });
          if (kind === 'detach' || kind === 'reassign') {
            expect(body.result).toEqual({ tagId: source.id, associations: 1, reassigned: kind === 'reassign' ? 1 : 0,
              detached: kind === 'detach' ? 1 : 0, childrenMoved: 0 });
            expect(await database.sql`select id from public.tags where id=${source.id}`).toEqual([]);
          }
          if (kind === 'goto') {
            expect(await database.sql`select org_id,created_by,state from public.goto_links where token=${body.token}`)
              .toEqual([{ org_id: actor.orgId, created_by: actor.userId, state: { synthetic: [1, null, { value: 'two' }] } }]);
            expect((await snapshot()).links.length).toBe(before.links.length + 1);
          }
        }
      }
      await database.sql`update public.org_members set role='owner' where org_id=${actor.orgId} and user_id=${actor.userId}`;
    }
    expect({ admitted, refused }).toEqual({ admitted: 9, refused: 3 });
  });

  it('refuses guessed objects and keeps a dual-member user bound to the selected agency', async () => {
    const actor = agencies[0]!; const other = agencies[1]!; const { source, target } = await setup(other);
    await database.sql`insert into public.org_members(org_id,user_id,role) values(${other.orgId},${actor.userId},'admin')`;
    try {
      const before = await snapshot();
      for (const kind of ['update','detach','reassign','assign','unassign'] as const) {
        expect((await call(kind, actor, input(kind, actor, target.id), source.id)).status).toBe(404);
      }
      expect((await call('create', actor, { name: randomUUID(), parentId: source.id })).status).toBe(404);
      const local = await setup(actor); const afterSetup = await snapshot();
      expect((await call('update', actor, { parentId: source.id }, local.source.id)).status).toBe(404);
      expect((await call('reassign', actor, { mode: 'reassign', targetTagId: target.id }, local.source.id)).status).toBe(404);
      for (const kind of ['assign','unassign'] as const) {
        const response = await call(kind, actor, input(kind, other, target.id), local.source.id);
        expect(response.status).toBe(200); expect((await response.json()).result).toMatchObject({ matchedByFilter: 0, requested: 0, unique: 0 });
      }
      expect(await snapshot()).toEqual(afterSetup);
      expect((await snapshot()).links).toEqual(before.links);
      const selected = { ...actor, orgId: other.orgId };
      expect((await call('update', selected, { name: randomUUID() }, source.id)).status).toBe(200);
    } finally { await database.sql`delete from public.org_members where org_id=${other.orgId} and user_id=${actor.userId}`; }
    const before = await snapshot();
    for (const kind of kinds) expect((await call(kind, { ...actor, orgId: other.orgId }, input(kind, other, target.id), source.id)).status).toBe(403);
    expect(await snapshot()).toEqual(before);
  });

  it('rejects malformed supplied filters instead of broadening a mutation', async () => {
    const actor = agencies[0]!; const { source } = await setup(actor); const before = await snapshot();
    let refused = 0;
    for (const kind of ['assign','unassign'] as const) {
      for (const filter of [{ entityType: 'campaign', profileIds: [2] }, { entityType: 'campaign', profileIds: ['bad'] },
        { entityType: 'campaign', entityIds: [false] }, { entityType: 'campaign', states: 'paused' },
        { entityType: 'campaign', states: ['bad'] }, { entityType: 'campaign', search: 2 },
        { entityType: 'profile', entityIds: ['bad'] }, null]) {
        expect((await call(kind, actor, { filter }, source.id)).status).toBe(400); refused++;
      }
    }
    expect(refused).toBe(16); expect(await snapshot()).toEqual(before);
    for (const body of [null, [], 1]) expect((await call('create', actor, body)).status).toBe(400);
    expect((await call('create', actor, { name: 'Synthetic', parentId: false })).status).toBe(400);
    expect((await call('update', actor, { name: 42 }, source.id)).status).toBe(400);
    expect((await call('goto', actor, { route: '/tags', expiresAt: 42 })).status).toBe(400);
    expect((await call('goto', actor, { route: '//example.invalid' })).status).toBe(400);
    expect(await snapshot()).toEqual(before);
  });

  it('uses authenticated RLS and sanitizes actual database failures without retaining sessions', async () => {
    const actor = agencies[0]!; const { source, target } = await setup(actor); const before = await snapshot();
    await database.sql`create policy mutation_tag_hidden on public.tags as restrictive for select to authenticated using(false)`;
    try {
      expect((await call('create', actor, { name: randomUUID() })).status).toBe(503);
      for (const kind of ['update','detach','reassign','assign','unassign'] as const) {
        expect((await call(kind, actor, input(kind, actor, target.id), source.id)).status).toBe(404);
      }
    } finally { await database.sql`drop policy mutation_tag_hidden on public.tags`; }
    await database.sql`create policy mutation_link_hidden on public.goto_links as restrictive for select to authenticated using(false)`;
    try { expect((await call('goto', actor, input('goto', actor, target.id))).status).toBe(503); }
    finally { await database.sql`drop policy mutation_link_hidden on public.goto_links`; }
    await database.sql`alter table public.tags rename column name to synthetic_private_name`;
    try {
      for (const kind of kinds.filter((kind) => kind !== 'goto')) {
        const response = await call(kind, actor, input(kind, actor, target.id), source.id);
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ error: 'The save could not be confirmed. Reload before trying again.' });
      }
    } finally { await database.sql`alter table public.tags rename column synthetic_private_name to name`; }
    expect(await snapshot()).toEqual(before);
  });

  it('verifies identity before opening any mutation pool and rolls back failed response serialization', async () => {
    const actor = agencies[0]!; const { source, target } = await setup(actor);
    const identify = vi.spyOn(requestContext, 'requestActor').mockRejectedValue(new requestContext.RequestAuthError('Authentication required', 401));
    const open = vi.spyOn(requestContext, 'openWebDatabase');
    try {
      for (const kind of kinds) expect((await call(kind, actor, input(kind, actor, target.id), source.id)).status).toBe(401);
      expect(open).not.toHaveBeenCalled();
    } finally { identify.mockRestore(); open.mockRestore(); }
    const before = await snapshot();
    const response = await authenticatedMutation(request('create', actor, {}), async (context) => {
      await createTag(context, { orgId: context.actor.orgId, name: randomUUID() });
      return Response.json({ synthetic: 1n });
    });
    expect(response.status).toBe(503); expect(await snapshot()).toEqual(before);
  });

  it('reports a committed link with failed close as uncertain and never creates a second link', async () => {
    const actor = agencies[0]!; const before = await snapshot(); const original = requestContext.openWebDatabase; let closes = 0;
    const open = vi.spyOn(requestContext, 'openWebDatabase').mockImplementation(() => {
      const handle = original();
      return { ...handle, close: async () => { closes++; await handle.close(); throw new Error('Synthetic private close failure'); } };
    });
    try {
      const response = await call('goto', actor, { route: '/tags', state: { marker: 'Synthetic uncertain link' } });
      expect(response.status).toBe(503); expect(closes).toBe(1); expect(open).toHaveBeenCalledTimes(1);
    } finally { open.mockRestore(); }
    const after = await snapshot(); expect(after.tags).toEqual(before.tags); expect(after.assignments).toEqual(before.assignments);
    expect(after.links.length).toBe(before.links.length + 1);
  });
});
