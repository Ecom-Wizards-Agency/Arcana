import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgActor, OrgRole } from '@wizard-ads/shared';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '../testing/harness.js';
import { asAnon, asServiceRole, asUser } from '../testing/rls.js';
import { withAuthenticatedIdentity } from './authenticated-actor.js';
import {
  FeedbackCommandError,
  countFeedback,
  getFeedbackItem,
  mutateFeedbackForActor,
} from './feedback.js';

const available = await databaseAvailable();

type Agency = {
  orgId: string;
  profileId: string;
  users: Record<OrgRole, string>;
};

const roles: readonly OrgRole[] = ['owner', 'admin', 'analyst', 'viewer'];

describe.skipIf(!available)('WP239 feedback authority', () => {
  let database: TestDatabase;
  const agencies: Agency[] = [];

  beforeAll(async () => {
    database = await createTestDatabase('feedback_authority');
    for (let index = 0; index < 3; index += 1) {
      const owner = randomUUID();
      const [org] = await database.sql<{ id: string }[]>`
        select app.seed_tenant_fixture(${`wp239-feedback-${index}-${randomUUID()}`}, ${owner}, 'owner') as id
      `;
      if (!org) throw new Error('feedback authority fixture did not create an agency');
      const [profile] = await database.sql<{ id: string }[]>`
        select id from public.ad_profiles where org_id = ${org.id} order by id limit 1
      `;
      if (!profile) throw new Error('feedback authority fixture did not create a profile');

      const users = { owner, admin: randomUUID(), analyst: randomUUID(), viewer: randomUUID() };
      for (const role of ['admin', 'analyst', 'viewer'] as const) {
        await database.sql`select public.auth_user_stub(${users[role]})`;
        await database.sql`
          insert into public.org_members(org_id, user_id, role)
          values (${org.id}, ${users[role]}, ${role}::public.org_role)
        `;
      }
      agencies.push({ orgId: org.id, profileId: profile.id, users });
    }
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  const actor = (agency: Agency, role: OrgRole): OrgActor => ({
    orgId: agency.orgId,
    userId: agency.users[role],
  });

  async function createItem(
    agency: Agency,
    role: OrgRole,
    type: 'bug' | 'feature',
    title = `WP239 ${type} ${randomUUID()}`,
  ) {
    const result = await mutateFeedbackForActor(database, actor(agency, role), {
      kind: 'create',
      type,
      title,
      body: `Synthetic body ${randomUUID()}`,
      ...(type === 'bug' ? { severity: 'medium' as const } : {}),
    });
    expect(result.kind).toBe('created');
    if (result.kind !== 'created') throw new Error('expected a created feedback item');
    return result.item;
  }

  function latch() {
    let release!: () => void;
    return {
      promise: new Promise<void>((resolve) => { release = resolve; }),
      release: () => release(),
    };
  }

  async function waitForLock(fragment: string): Promise<void> {
    for (let attempt = 0; attempt < 250; attempt += 1) {
      const rows = await database.sql<{ pid: number }[]>`
        select pid
          from pg_stat_activity
         where datname = current_database()
           and wait_event_type = 'Lock'
           and position(${fragment} in query) > 0
      `;
      if (rows.length > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Expected a query containing ${fragment} to wait for a lock`);
  }

  async function waitForTriggerActivity(fragment: string): Promise<void> {
    for (let attempt = 0; attempt < 250; attempt += 1) {
      const rows = await database.sql<{ pid: number }[]>`
        select pid
          from pg_stat_activity
         where datname = current_database()
           and wait_event_type = 'Timeout'
           and position(${fragment} in query) > 0
      `;
      if (rows.length > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Expected a query containing ${fragment} to be inside its trigger wait`);
  }

  it('creates bug/new and feature/planned for every role in three agencies with exact counts', async () => {
    const before = await Promise.all(agencies.map((agency) => countFeedback(database, agency.orgId)));
    let created = 0;
    for (const [index, agency] of agencies.entries()) {
      for (const role of roles) {
        const bug = await createItem(agency, role, 'bug');
        const feature = await createItem(agency, role, 'feature');
        expect(bug.status).toBe('new');
        expect(feature.status).toBe('planned');
        expect(bug.orgId).toBe(agency.orgId);
        expect(feature.orgId).toBe(agency.orgId);
        created += 2;
      }
      const after = await countFeedback(database, agency.orgId);
      expect(after.total).toBe(before[index]!.total + 8);
      expect(after.openBugs).toBe(before[index]!.openBugs + 4);
      expect(after.openFeatures).toBe(before[index]!.openFeatures + 4);
    }
    expect(created).toBe(24);
  }, 60_000);

  it('preserves legacy feature/new insertion and the lock/policy ACL boundaries', async () => {
    const agency = agencies[0]!;
    const viewer = agency.users.viewer;
    const rows = await asUser(database, viewer, (sql) => sql<{ id: string; status: string }[]>`
      insert into public.feedback_items (org_id, author_id, type, title)
      values (${agency.orgId}, ${viewer}, 'feature', ${`WP239 legacy feature ${randomUUID()}`})
      returning id, status::text as status
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('new');

    const [privileges] = await database.sql<{
      memberInsert: boolean;
      memberUpdate: boolean;
      feedbackInsert: boolean;
      lockAuthenticated: boolean;
      lockAnon: boolean;
      lockService: boolean;
    }[]>`
      select
        has_table_privilege('authenticated', 'public.org_members', 'INSERT') as "memberInsert",
        has_table_privilege('authenticated', 'public.org_members', 'UPDATE') as "memberUpdate",
        has_table_privilege('authenticated', 'public.feedback_items', 'INSERT') as "feedbackInsert",
        has_function_privilege('authenticated', 'app.lock_feedback_member(uuid)', 'EXECUTE') as "lockAuthenticated",
        has_function_privilege('anon', 'app.lock_feedback_member(uuid)', 'EXECUTE') as "lockAnon",
        has_function_privilege('service_role', 'app.lock_feedback_member(uuid)', 'EXECUTE') as "lockService"
    `;
    expect(privileges).toEqual({
      memberInsert: false,
      memberUpdate: false,
      feedbackInsert: true,
      lockAuthenticated: true,
      lockAnon: false,
      lockService: false,
    });

    await asUser(database, viewer, async (sql) => {
      await sql`select app.lock_feedback_member(${agency.orgId}::uuid)`;
    });
    await asAnon(database, async (sql) => {
      await expect(sql`select app.lock_feedback_member(${agency.orgId}::uuid)`).rejects.toMatchObject({ code: '42501' });
    });
    await asServiceRole(database, async (sql) => {
      await expect(sql`select app.lock_feedback_member(${agency.orgId}::uuid)`).rejects.toMatchObject({ code: '42501' });
    });
  });

  it('keeps viewer participation while enforcing author, manager, foreign-id and dual-membership scope', async () => {
    const [agencyA, agencyB, agencyC] = agencies as [Agency, Agency, Agency];
    const ownerItem = await createItem(agencyA, 'owner', 'bug', `WP239 restrictions owner ${randomUUID()}`);
    const viewerItem = await createItem(agencyA, 'viewer', 'bug', `WP239 restrictions viewer ${randomUUID()}`);
    const foreignItem = await createItem(agencyB, 'owner', 'bug', `WP239 restrictions foreign ${randomUUID()}`);

    await expect(mutateFeedbackForActor(database, actor(agencyA, 'viewer'), {
      kind: 'triage', itemId: ownerItem.id, status: 'triaged',
    })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(mutateFeedbackForActor(database, actor(agencyA, 'analyst'), {
      kind: 'triage', itemId: ownerItem.id, status: 'triaged',
    })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(mutateFeedbackForActor(database, actor(agencyA, 'viewer'), {
      kind: 'edit', itemId: ownerItem.id, title: 'not my item',
    })).rejects.toMatchObject({ code: 'forbidden' });

    const edited = await mutateFeedbackForActor(database, actor(agencyA, 'viewer'), {
      kind: 'edit', itemId: viewerItem.id, title: 'edited title', body: 'edited body', severity: 'high',
    });
    expect(edited.kind).toBe('updated');
    await expect(mutateFeedbackForActor(database, actor(agencyA, 'owner'), {
      kind: 'triage', itemId: viewerItem.id, status: 'triaged',
    })).resolves.toMatchObject({ kind: 'updated' });
    await expect(mutateFeedbackForActor(database, actor(agencyA, 'viewer'), {
      kind: 'edit', itemId: viewerItem.id, body: 'late edit',
    })).rejects.toMatchObject({ code: 'forbidden' });

    await expect(mutateFeedbackForActor(database, actor(agencyA, 'owner'), {
      kind: 'toggleVote', itemId: foreignItem.id,
    })).rejects.toMatchObject({ code: 'not_found' });
    await expect(mutateFeedbackForActor(database, actor(agencyA, 'owner'), {
      kind: 'toggleVote', itemId: randomUUID(),
    })).rejects.toMatchObject({ code: 'not_found' });
    await expect(mutateFeedbackForActor(database, actor(agencyA, 'owner'), {
      kind: 'duplicate', itemId: ownerItem.id, duplicateOf: foreignItem.id,
    })).rejects.toMatchObject({ code: 'not_found' });
    await expect(mutateFeedbackForActor(database, actor(agencyA, 'owner'), {
      kind: 'duplicate', itemId: ownerItem.id, duplicateOf: randomUUID(),
    })).rejects.toMatchObject({ code: 'not_found' });
    await expect(mutateFeedbackForActor(database, actor(agencyA, 'owner'), {
      kind: 'create', type: 'bug', title: `WP239 foreign profile ${randomUUID()}`, severity: 'low',
      pageContext: { route: '/feedback', profileId: agencyB.profileId, appVersion: 'synthetic' },
    })).rejects.toMatchObject({ code: 'not_found' });
    await expect(mutateFeedbackForActor(database, actor(agencyA, 'owner'), {
      kind: 'create', type: 'bug', title: `WP239 guessed profile ${randomUUID()}`, severity: 'low',
      pageContext: { route: '/feedback', profileId: randomUUID(), appVersion: 'synthetic' },
    })).rejects.toMatchObject({ code: 'not_found' });

    const dual = randomUUID();
    await database.sql`select public.auth_user_stub(${dual})`;
    for (const agency of [agencyA, agencyB]) {
      await database.sql`
        insert into public.org_members(org_id, user_id, role)
        values (${agency.orgId}, ${dual}, 'viewer')
      `;
    }
    for (const agency of [agencyA, agencyB]) {
      const result = await mutateFeedbackForActor(database, { orgId: agency.orgId, userId: dual }, {
        kind: 'create', type: 'feature', title: `WP239 dual ${agency.orgId}`,
      });
      expect(result.kind).toBe('created');
      if (result.kind === 'created') expect(result.item.orgId).toBe(agency.orgId);
    }
    await expect(mutateFeedbackForActor(database, { orgId: agencyC.orgId, userId: dual }, {
      kind: 'create', type: 'bug', title: `WP239 dual foreign ${randomUUID()}`,
    })).rejects.toMatchObject({ code: 'forbidden' });
  }, 60_000);

  it('preserves omitted fields and exact same-user toggle parity with independent counts', async () => {
    const agency = agencies[1]!;
    const item = await createItem(agency, 'viewer', 'bug', `WP239 vote parity ${randomUUID()}`);
    const edited = await mutateFeedbackForActor(database, actor(agency, 'viewer'), {
      kind: 'edit', itemId: item.id, title: 'omitted fields title', body: 'kept severity', severity: 'low',
    });
    expect(edited.kind).toBe('updated');
    const titleOnly = await mutateFeedbackForActor(database, actor(agency, 'viewer'), {
      kind: 'edit', itemId: item.id, title: 'title only',
    });
    expect(titleOnly).toMatchObject({ kind: 'updated', item: { title: 'title only', body: 'kept severity', severity: 'low' } });
    const clearSeverity = await mutateFeedbackForActor(database, actor(agency, 'viewer'), {
      kind: 'edit', itemId: item.id, severity: null,
    });
    expect(clearSeverity).toMatchObject({ kind: 'updated', item: { title: 'title only', body: 'kept severity', severity: null } });

    const offResults = await Promise.all([
      mutateFeedbackForActor(database, actor(agency, 'viewer'), { kind: 'toggleVote', itemId: item.id }),
      mutateFeedbackForActor(database, actor(agency, 'viewer'), { kind: 'toggleVote', itemId: item.id }),
    ]);
    expect(offResults.map((result) => result.kind === 'vote' ? result.votes : -1).sort((a, b) => a - b)).toEqual([0, 1]);
    expect((await getFeedbackItem(database, { orgId: agency.orgId, itemId: item.id }))?.votes).toBe(0);

    await expect(mutateFeedbackForActor(database, actor(agency, 'viewer'), {
      kind: 'toggleVote', itemId: item.id,
    })).resolves.toMatchObject({ kind: 'vote', voted: true, votes: 1 });
    const onResults = await Promise.all([
      mutateFeedbackForActor(database, actor(agency, 'viewer'), { kind: 'toggleVote', itemId: item.id }),
      mutateFeedbackForActor(database, actor(agency, 'viewer'), { kind: 'toggleVote', itemId: item.id }),
    ]);
    expect(onResults.map((result) => result.kind === 'vote' ? result.votes : -1).sort((a, b) => a - b)).toEqual([0, 1]);
    expect((await getFeedbackItem(database, { orgId: agency.orgId, itemId: item.id }))?.votes).toBe(1);

    const independent = await Promise.all([
      mutateFeedbackForActor(database, actor(agency, 'analyst'), { kind: 'toggleVote', itemId: item.id }),
      mutateFeedbackForActor(database, actor(agency, 'admin'), { kind: 'toggleVote', itemId: item.id }),
    ]);
    expect(independent.every((result) => result.kind === 'vote')).toBe(true);
    expect((await getFeedbackItem(database, { orgId: agency.orgId, itemId: item.id }))?.votes).toBe(3);
  }, 60_000);

  it('rolls back readback and deferred commit failures without leaking input or retrying', async () => {
    const agency = agencies[2]!;
    await database.sql`
      create function public.wp239_delete_feedback_after_insert()
      returns trigger
      language plpgsql
      security definer
      set search_path = pg_catalog, public, pg_temp
      as $$
      begin
        if new.title like 'WP239 readback failure%' then
          delete from public.feedback_items where id = new.id;
        end if;
        return new;
      end;
      $$
    `;
    await database.sql`
      create trigger wp239_delete_feedback_after_insert
      after insert on public.feedback_items
      for each row execute function public.wp239_delete_feedback_after_insert()
    `;
    try {
      const title = `WP239 readback failure ${randomUUID()}`;
      const error = await mutateFeedbackForActor(database, actor(agency, 'viewer'), {
        kind: 'create', type: 'bug', title, body: 'private synthetic body', severity: 'low',
      }).then(() => null, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(FeedbackCommandError);
      expect((error as FeedbackCommandError).code).toBe('unconfirmed');
      expect((error as FeedbackCommandError).message).toBe('The save could not be confirmed. Reload before trying again.');
      expect(JSON.stringify(error)).not.toContain(title);
      expect(JSON.stringify(error)).not.toContain('private synthetic body');
      expect(await database.sql`select count(*)::int as count from public.feedback_items where title=${title}`)
        .toEqual([{ count: 0 }]);
    } finally {
      await database.sql`drop trigger wp239_delete_feedback_after_insert on public.feedback_items`;
      await database.sql`drop function public.wp239_delete_feedback_after_insert()`;
    }

    await database.sql`
      create function public.wp239_reject_feedback_commit()
      returns trigger
      language plpgsql
      set search_path = pg_catalog, public, pg_temp
      as $$
      begin
        if new.title like 'WP239 commit failure%' then
          raise exception 'synthetic deferred commit failure';
        end if;
        return new;
      end;
      $$
    `;
    await database.sql`
      create constraint trigger wp239_reject_feedback_commit
      after insert on public.feedback_items
      deferrable initially deferred
      for each row execute function public.wp239_reject_feedback_commit()
    `;
    try {
      const title = `WP239 commit failure ${randomUUID()}`;
      const error = await mutateFeedbackForActor(database, actor(agency, 'viewer'), {
        kind: 'create', type: 'bug', title, body: 'commit synthetic body', severity: 'low',
      }).then(() => null, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(FeedbackCommandError);
      expect((error as FeedbackCommandError).code).toBe('unconfirmed');
      expect(JSON.stringify(error)).not.toContain(title);
      expect(JSON.stringify(error)).not.toContain('commit synthetic body');
      expect(await database.sql`select count(*)::int as count from public.feedback_items where title=${title}`)
        .toEqual([{ count: 0 }]);
    } finally {
      await database.sql`drop trigger wp239_reject_feedback_commit on public.feedback_items`;
      await database.sql`drop function public.wp239_reject_feedback_commit()`;
    }
  }, 60_000);

  it('holds the member lock through commit in both downgrade and removal orders', async () => {
    const agency = agencies[0]!;
    await database.sql`
      create function public.wp239_pause_feedback_write()
      returns trigger
      language plpgsql
      set search_path = pg_catalog, public, pg_temp
      as $$
      begin
        if new.title like 'WP239 lock-write%' then perform pg_sleep(0.35); end if;
        return new;
      end;
      $$
    `;
    await database.sql`
      create trigger wp239_pause_feedback_write
      before insert or update on public.feedback_items
      for each row execute function public.wp239_pause_feedback_write()
    `;
    try {
      for (const change of ['downgrade', 'remove'] as const) {
        for (const first of ['authority', 'write'] as const) {
          const target = randomUUID();
          await database.sql`select public.auth_user_stub(${target})`;
          await database.sql`
            insert into public.org_members(org_id, user_id, role)
            values (${agency.orgId}, ${target}, ${change === 'downgrade' ? 'admin' : 'analyst'})
          `;
          const selected: OrgActor = { orgId: agency.orgId, userId: target };
          let targetItemId: string | undefined;
          if (change === 'downgrade') {
            const item = await createItem(
              agency,
              'owner',
              'bug',
              `WP239 lock-write target ${randomUUID()}`,
            );
            targetItemId = item.id;
          }
          const ready = latch();
          const release = latch();
          const updateAuthority = async () => withAuthenticatedIdentity(
            database,
            { userId: agency.users.owner },
            async (sql) => {
              if (first === 'authority') {
                await sql`select app.lock_feedback_member(${agency.orgId}::uuid)`;
                if (change === 'downgrade') {
                  await sql`select app.change_org_member_role(${agency.orgId}::uuid, ${target}::uuid, 'viewer'::public.org_role)`;
                } else {
                  await sql`select app.remove_org_member(${agency.orgId}::uuid, ${target}::uuid)`;
                }
                ready.release();
                await release.promise;
              } else if (change === 'downgrade') {
                await sql`select app.change_org_member_role(${agency.orgId}::uuid, ${target}::uuid, 'viewer'::public.org_role)`;
              } else {
                await sql`select app.remove_org_member(${agency.orgId}::uuid, ${target}::uuid)`;
              }
            },
          );

          if (first === 'authority') {
            const authority = updateAuthority();
            await ready.promise;
            const operation = mutateFeedbackForActor(database, selected, change === 'downgrade'
              ? { kind: 'triage', itemId: targetItemId!, status: 'triaged' }
              : { kind: 'create', type: 'bug', title: `WP239 lock-authority ${change} ${randomUUID()}`, severity: 'low' });
            const refused = expect(operation).rejects.toMatchObject({ code: 'forbidden' });
            try {
              await waitForLock('app.lock_feedback_member');
            } finally {
              release.release();
            }
            await authority;
            await refused;
          } else {
            const operation = mutateFeedbackForActor(database, selected, change === 'downgrade'
              ? { kind: 'triage', itemId: targetItemId!, status: 'triaged' }
              : { kind: 'create', type: 'bug', title: `WP239 lock-write ${change} ${randomUUID()}`, severity: 'low' });
            await waitForTriggerActivity(change === 'downgrade'
              ? 'update public.feedback_items'
              : 'insert into public.feedback_items');
            const authority = updateAuthority();
            try {
              await waitForLock(change === 'downgrade' ? 'app.change_org_member_role' : 'app.remove_org_member');
            } finally {
              await operation;
            }
            await authority;
          }

          if (change === 'downgrade') {
            const [persisted] = await database.sql<{ status: string }[]>`
              select status from public.feedback_items where id=${targetItemId!}
            `;
            expect(persisted?.status).toBe(first === 'write' ? 'triaged' : 'new');
            await expect(mutateFeedbackForActor(database, selected, {
              kind: 'triage', itemId: targetItemId!, status: 'declined',
            })).rejects.toMatchObject({ code: 'forbidden' });
          } else {
            const [persisted] = await database.sql<{ count: number }[]>`
              select count(*)::int as count from public.feedback_items
               where org_id=${agency.orgId} and author_id=${target}
            `;
            expect(persisted?.count).toBe(first === 'write' ? 1 : 0);
            await expect(mutateFeedbackForActor(database, selected, {
              kind: 'create', type: 'bug', title: `WP239 post-lock ${change} ${randomUUID()}`,
              severity: 'low',
            })).rejects.toMatchObject({ code: 'forbidden' });
          }
        }
      }
    } finally {
      await database.sql`drop trigger wp239_pause_feedback_write on public.feedback_items`;
      await database.sql`drop function public.wp239_pause_feedback_write()`;
    }
  }, 60_000);
});
