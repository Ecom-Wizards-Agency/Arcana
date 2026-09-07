import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '../testing/harness.js';
import { asActor, asAnon, asServiceRole } from '../testing/rls.js';
import { withAuthenticatedActor } from './authenticated-actor.js';
import { createGotoLink, consumeGotoLinkForActor, type GotoLinkRecord } from './goto.js';

const available = await databaseAvailable();
const signingSecret = ['synthetic', 'member', 'navigation', 'signing', 'material'].join('-');
interface Agency { orgId: string; userId: string }

describe.skipIf(!available)('current-member goto consumption', () => {
  let database: TestDatabase;
  const agencies: Agency[] = [];
  beforeAll(async () => {
    database = await createTestDatabase('goto_member_consumption');
    for (let i = 0; i < 3; i++) {
      const userId = randomUUID();
      const [org] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture(${randomUUID()},${userId},'owner') as id`;
      agencies.push({ userId, orgId: org!.id });
    }
  }, 60_000);
  afterAll(async () => { await database?.drop(); });
  const create = (actor: Agency, expiresAt?: Date) => createGotoLink(database, {
    orgId: actor.orgId, route: '/tags?view=campaigns',
    state: { synthetic: actor.orgId, nested: { values: [1, null, 'term'] } },
    createdBy: actor.userId, signingSecret, expiresAt,
  });
  const consume = (actor: Agency, link: GotoLinkRecord) =>
    consumeGotoLinkForActor(database, actor, { token: link.token, signingSecret });
  async function stored(link: GotoLinkRecord) {
    const [row] = await database.sql`select * from public.goto_links where id=${link.id}`;
    return row!;
  }
  async function waitForCommandLock(): Promise<void> {
    for (let i = 0; i < 200; i++) {
      const rows = await database.sql`select pid from pg_stat_activity where datname=current_database()
        and wait_event_type='Lock' and query like '%select app.consume_goto_link(%'`;
      if (rows.length > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Synthetic command did not reach its expected lock');
  }
  function latch() {
    let release!: () => void;
    return { promise: new Promise<void>((resolve) => { release = resolve; }), release: () => release() };
  }

  it('keeps three agencies and selected memberships separate with exact counted visits', async () => {
    const links = await Promise.all(agencies.map((actor) => create(actor)));
    let accepted = 0; let denied = 0;
    for (const [index, actor] of agencies.entries()) {
      const link = links[index]!;
      const before = await stored(link);
      const result = await consume(actor, link);
      expect(result).toMatchObject({ id: link.id, state: link.state, uses: 1 });
      const after = await stored(link);
      expect(after).toEqual({ ...before, uses: 1, last_used_at: after['last_used_at'] });
      expect(after['last_used_at']).not.toBeNull(); accepted++;
      for (const [otherIndex, other] of agencies.entries()) {
        if (other === actor) continue;
        expect(await consume(actor, links[otherIndex]!)).toBeNull();
        await expect(consume({ ...actor, orgId: other.orgId }, links[otherIndex]!)).rejects.toThrow('Resource not found');
        denied += 2;
      }
    }
    expect({ accepted, denied }).toEqual({ accepted: 3, denied: 12 });
    const counts = await database.sql<{ visits: number }[]>`select sum(uses)::int as visits from public.goto_links where id=any(${links.map((link) => link.id)}::uuid[])`;
    expect(counts).toEqual([{ visits: 3 }]);
  });

  it('permits viewer navigation while direct link edits remain refused', async () => {
    const owner = agencies[0]!; const viewer = { userId: agencies[1]!.userId, orgId: owner.orgId };
    const link = await create(owner);
    await database.sql`insert into public.org_members(org_id,user_id,role) values(${viewer.orgId},${viewer.userId},'viewer')`;
    try {
      await withAuthenticatedActor(database, viewer, async (sql) => {
        expect(await sql`update public.goto_links set route='/grid', uses=999 where id=${link.id} returning id`).toEqual([]);
        expect(await sql`delete from public.goto_links where id=${link.id} returning id`).toEqual([]);
      });
      expect(await consume(viewer, link)).toMatchObject({ route: link.route, state: link.state, uses: 1 });
    } finally { await database.sql`delete from public.org_members where org_id=${viewer.orgId} and user_id=${viewer.userId}`; }
    await expect(consume(viewer, link)).rejects.toThrow('Resource not found');
    expect((await stored(link))['uses']).toBe(1);
  });

  it('rolls back a counted visit when authenticated RLS hides its return', async () => {
    const actor = agencies[0]!; const link = await create(actor); const before = await stored(link);
    await database.sql`create policy goto_return_hidden on public.goto_links as restrictive for select to authenticated using(false)`;
    try { await expect(consume(actor, link)).rejects.toThrow('Link visit could not be confirmed'); }
    finally { await database.sql`drop policy goto_return_hidden on public.goto_links`; }
    expect(await stored(link)).toEqual(before);
    expect((await consume(actor, link))?.uses).toBe(1);
  });

  it('refuses malformed or expired links and rolls back an invalid stored destination', async () => {
    const actor = agencies[0]!; const link = await create(actor);
    const expired = await create(actor, new Date('2020-01-01T00:00:00Z'));
    expect(await consumeGotoLinkForActor(database, actor, { token: link.token + 'x', signingSecret })).toBeNull();
    expect(await consume(actor, expired)).toBeNull();
    await database.sql`update public.goto_links set route='//outside.example/path' where id=${link.id}`;
    await expect(consume(actor, link)).rejects.toThrow('internal application path');
    expect((await stored(link))['uses']).toBe(0);
    expect((await stored(expired))['uses']).toBe(0);
  });

  it('limits command execution to authenticated callers with a current membership', async () => {
    const actor = agencies[0]!; const link = await create(actor);
    for (const asRole of [asAnon, asServiceRole]) {
      await asRole(database, async (sql) => {
        await expect(sql`select app.consume_goto_link(${actor.orgId}::uuid,${link.token})`).rejects.toThrow(/permission denied/i);
      });
    }
    await asActor(database, { role: 'authenticated' }, async (sql) => {
      await expect(sql`select app.consume_goto_link(${actor.orgId}::uuid,${link.token})`).rejects.toThrow('Resource not found');
    });
    expect((await stored(link))['uses']).toBe(0);
  });

  it('refuses a membership removal that commits while the command waits for authority', async () => {
    const actor = agencies[0]!; const link = await create(actor);
    const locked = latch(); const release = latch();
    const deletion = database.sql.begin(async (sql) => {
      await sql`delete from public.org_members where org_id=${actor.orgId} and user_id=${actor.userId}`;
      locked.release(); await release.promise;
    });
    await locked.promise;
    const pending = consume(actor, link).then((value) => ({ value, error: null }), (error: unknown) => ({ value: null, error }));
    try { await waitForCommandLock(); }
    finally { release.release(); await deletion; }
    try {
      expect((await pending).error).toMatchObject({ code: '42501' });
      expect((await stored(link))['uses']).toBe(0);
    } finally { await database.sql`insert into public.org_members(org_id,user_id,role) values(${actor.orgId},${actor.userId},'owner')`; }
  });

  it('holds membership through a visit admitted before removal', async () => {
    const actor = agencies[0]!; const link = await create(actor);
    const locked = latch(); const release = latch();
    const holder = database.sql.begin(async (sql) => {
      await sql`select id from public.goto_links where id=${link.id} for update`;
      locked.release(); await release.promise;
    });
    await locked.promise;
    const pending = consume(actor, link);
    let removal!: Promise<unknown>;
    try {
      await waitForCommandLock();
      // Command holds membership but waits for the link; removal must wait.
      removal = database.sql`delete from public.org_members where org_id=${actor.orgId} and user_id=${actor.userId}`.execute();
      let blocked = false;
      for (let i = 0; i < 200; i++) {
        const rows = await database.sql`select pid from pg_stat_activity where datname=current_database()
          and wait_event_type='Lock' and query like 'delete from public.org_members%'`;
        if (rows.length > 0) { blocked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
    } finally { release.release(); await holder; }
    try {
      expect((await pending)?.uses).toBe(1);
      await removal;
      await expect(consume(actor, link)).rejects.toThrow('Resource not found');
      expect((await stored(link))['uses']).toBe(1);
    } finally { await database.sql`insert into public.org_members(org_id,user_id,role) values(${actor.orgId},${actor.userId},'owner') on conflict do nothing`; }
  });

  it('uses database time after a contended link expires', async () => {
    const actor = agencies[0]!; const link = await create(actor);
    const locked = latch(); const release = latch();
    const holder = database.sql.begin(async (sql) => {
      await sql`update public.goto_links set expires_at=clock_timestamp()+interval '200 milliseconds' where id=${link.id}`;
      locked.release(); await release.promise;
    });
    await locked.promise;
    const pending = consume(actor, link);
    try { await waitForCommandLock(); await database.sql`select pg_sleep(0.3)`; }
    finally { release.release(); await holder; }
    expect(await pending).toBeNull();
    expect((await stored(link))['uses']).toBe(0);
  });
});
