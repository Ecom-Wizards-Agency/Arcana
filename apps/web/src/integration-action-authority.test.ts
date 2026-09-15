import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import { createCompetitorLink, createIntegrationConnection, storeIntegrationSecret } from '@wizard-ads/db';
import type { OrgRole } from '@wizard-ads/shared';
import { addCompetitorLink, connectIntegration, deleteCompetitorLink, revokeIntegration } from '../app/settings/integrations/actions';
import { operatorFailureLabel } from './security/operator-failure';

let database: TestDatabase;
interface Agency { orgId: string; userId: string; profileId: string }
const agencies: Agency[] = [];
let actor: Agency;
let cachedRole: OrgRole = 'owner';
vi.mock('./auth/guard', () => ({ gateAction: async () => ({
  handle: database, active: { orgId: actor.orgId, role: cachedRole }, userId: actor.userId,
}) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const available = await databaseAvailable();
const actions = { connect: connectIntegration, revoke: revokeIntegration, add: addCompetitorLink, remove: deleteCompetitorLink };
type Action = keyof typeof actions;
const credential = () => ['synthetic', randomUUID()].join('-');
let sequence = 0;
const form = (values: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};

async function input(action: Action) {
  const label = randomUUID();
  if (action === 'connect') return form({ provider: 'keepa', label, secret: credential() });
  if (action === 'revoke') {
    const connection = await createIntegrationConnection(database, { orgId: actor.orgId, provider: 'keepa', label });
    await storeIntegrationSecret(database, connection.id, credential());
    return form({ connectionId: connection.id });
  }
  const ourAsin = `Z${(++sequence).toString(36).toUpperCase().padStart(9, '0')}`;
  const details = { orgId: actor.orgId, profileId: actor.profileId, ourAsin, competitorAsin: 'B0TEST0401' };
  if (action === 'add') return form(details);
  const link = await createCompetitorLink(database, details);
  return form({ linkId: link.id });
}
const snapshot = async () => ({
  connections: await database.sql`select * from public.integration_connections order by id`,
  links: await database.sql`select * from public.competitor_links order by id`,
  audits: await database.sql`select * from public.audit_log order by id`,
  vault: await database.sql`select * from vault.secrets order by id`,
});

describe.skipIf(!available)('integration actions after a stale session capability check', () => {
  beforeAll(async () => {
    database = await createTestDatabase('integration_actions');
    for (let i = 0; i < 3; i++) {
      const userId = randomUUID();
      const [org] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture(${randomUUID()},${userId},'owner') as id`;
      const [profile] = await database.sql<{ id: string }[]>`select id from public.ad_profiles where org_id=${org!.id}`;
      agencies.push({ orgId: org!.id, userId, profileId: profile!.id });
    }
    actor = agencies[0]!;
  }, 60_000);
  afterEach(async () => {
    vi.restoreAllMocks(); cachedRole = 'owner'; actor = agencies[0]!;
    for (const agency of agencies) await database.sql`insert into public.org_members(org_id,user_id,role)
      values(${agency.orgId},${agency.userId},'owner') on conflict(org_id,user_id) do update set role='owner'`;
  });
  afterAll(async () => { await database?.drop(); });

  it.each(Object.keys(actions) as Action[])('%s checks current authority across three unrelated agencies and four roles', async (action) => {
    let admitted = 0; let refused = 0;
    const close = vi.spyOn(database, 'close');
    for (const agency of agencies) {
      actor = agency;
      for (const role of ['owner', 'admin', 'analyst', 'viewer'] as const) {
        const data = await input(action);
        await database.sql`update public.org_members set role=${role} where org_id=${actor.orgId} and user_id=${actor.userId}`;
        const before = await snapshot();
        if (role === 'viewer' || (role === 'analyst' && (action === 'connect' || action === 'revoke'))) {
          await expect(actions[action](data)).rejects.toThrow();
          expect(await snapshot()).toEqual(before); refused++;
        } else { await actions[action](data); admitted++; }
      }
    }
    expect({ admitted, refused }).toEqual(action === 'connect' || action === 'revoke'
      ? { admitted: 6, refused: 6 } : { admitted: 9, refused: 3 });
    expect(close).not.toHaveBeenCalled();
  });

  it('refuses removed membership in all four actual actions without changing any resource', async () => {
    const prepared = await Promise.all((Object.keys(actions) as Action[]).map(async (action) => ({ action, data: await input(action) })));
    await database.sql`delete from public.org_members where org_id=${actor.orgId} and user_id=${actor.userId}`;
    const before = await snapshot();
    for (const { action, data } of prepared) await expect(actions[action](data)).rejects.toThrow('Resource not found');
    expect(await snapshot()).toEqual(before);
  });

  it('refuses foreign IDs even for a dual-agency member and retains authenticated RLS for competitor writes', async () => {
    const first = actor; actor = agencies[1]!;
    const foreignRevoke = await input('revoke'); const foreignRemove = await input('remove'); actor = first;
    await database.sql`insert into public.org_members(org_id,user_id,role) values(${agencies[1]!.orgId},${actor.userId},'owner')`;
    const before = await snapshot();
    await expect(revokeIntegration(foreignRevoke)).rejects.toThrow('not found');
    await expect(deleteCompetitorLink(foreignRemove)).rejects.toThrow('not found');
    await expect(addCompetitorLink(form({ profileId: agencies[1]!.profileId, ourAsin: 'B0TEST0411', competitorAsin: 'B0TEST0412' })))
      .rejects.toThrow('profile not found');
    expect(await snapshot()).toEqual(before);
    const ownRemove = await input('remove'); const ownAdd = await input('add'); const ownBefore = await snapshot();
    await database.sql`create policy synthetic_competitor_insert_denied on public.competitor_links
      as restrictive for insert to authenticated with check(false)`;
    await database.sql`create policy synthetic_competitor_delete_denied on public.competitor_links
      as restrictive for delete to authenticated using(false)`;
    try {
      await expect(addCompetitorLink(ownAdd)).rejects.toMatchObject({ code: '42501' });
      await expect(deleteCompetitorLink(ownRemove)).rejects.toThrow('not found');
      expect(await snapshot()).toEqual(ownBefore);
    } finally {
      await database.sql`drop policy synthetic_competitor_insert_denied on public.competitor_links`;
      await database.sql`drop policy synthetic_competitor_delete_denied on public.competitor_links`;
    }
  });

  it('commits only the fixed visible failure and safe audit when actual credential replacement fails', async () => {
    const label = randomUUID(); const prior = credential(); const proposed = credential();
    await connectIntegration(form({ provider: 'datadive', label, secret: prior }));
    const [connection] = await database.sql<{ id: string }[]>`select id from public.integration_connections where org_id=${actor.orgId} and label=${label}`;
    await database.sql`create function public.refuse_action_activation() returns trigger language plpgsql as $$
      begin if new.status='active' then raise exception 'synthetic private storage detail'; end if; return new; end $$`;
    await database.sql`create trigger refuse_action_activation before update on public.integration_connections
      for each row execute function public.refuse_action_activation()`;
    try {
      await expect(connectIntegration(form({ provider: 'datadive', label, secret: proposed }))).resolves.toBeUndefined();
      const [row] = await database.sql<{ status: string; last_error: string }[]>`select status::text,last_error
        from public.integration_connections where id=${connection!.id}`;
      expect(row).toEqual({ status: 'error', last_error: 'The credential could not be stored in Vault.' });
      expect(operatorFailureLabel(row!.last_error)).toContain('Ask your installation operator');
      const [stored] = await database.sql<{ value: string }[]>`select public.get_integration_secret(${connection!.id}) as value`;
      expect(stored?.value).toBe(prior);
      const audits = await database.sql`select payload from public.audit_log where target_id=${connection!.id}`;
      expect(audits).toHaveLength(2);
      for (const forbidden of [prior, proposed, 'synthetic private storage detail']) expect(JSON.stringify({ row, audits })).not.toContain(forbidden);
    } finally {
      await database.sql`drop trigger refuse_action_activation on public.integration_connections`;
      await database.sql`drop function public.refuse_action_activation()`;
    }
  });
});
