import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import { POST as groupSave } from '../app/api/optimizer/groups/route';
import { POST as groupPreview } from '../app/api/optimizer/groups/run/route';
import { POST as batchPreview } from '../app/api/optimizer/runs/route';
import { POST as oneTimePreview } from '../app/api/optimizer/runs/one-time/route';
import * as requestContext from './server/request-context';

const available = await databaseAvailable();
const bridge = 'synthetic-optimization-mutation-bridge';
const application = 'synthetic-optimization-mutation-' + randomUUID();
const revision = 'c'.repeat(40);
const routes = { groupSave, groupPreview, batchPreview, oneTimePreview };
type Kind = keyof typeof routes;
interface Agency { orgId: string; userId: string; profileId: string; groupId: string }
const configuration = { version: 1, method: 'rpc', targetAcos: 0.37, bidFloor: 0.11, bidCeiling: 4.3,
  bidIncreaseCap: 0.23, bidDecreaseCap: 0.41, window: { start: '2026-08-01', end: '2026-08-26' } };

describe.skipIf(!available)('agency optimization mutations through actual HTTP handlers', () => {
  let database: TestDatabase;
  beforeAll(async () => {
    database = await createTestDatabase('optimization_mutation_agency');
    const url = new URL(database.connectionString); url.searchParams.set('application_name', application);
    vi.stubEnv('DATABASE_URL', url.toString());
    vi.stubEnv('WIZARD_ADS_E2E_AUTH_BRIDGE', '1');
    vi.stubEnv('WIZARD_ADS_AUTH_BRIDGE_SECRET', bridge);
  }, 60_000);
  afterAll(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await database?.drop(); });
  async function agency(): Promise<Agency> {
    const userId = randomUUID();
    const [org] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture(${randomUUID()},${userId},'owner') as id`;
    const [profile] = await database.sql<{ id: string }[]>`select id from public.ad_profiles where org_id=${org!.id}`;
    const [group] = await database.sql<{ id: string }[]>`select id from public.optimization_groups where org_id=${org!.id}`;
    return { orgId: org!.id, profileId: profile!.id, groupId: group!.id, userId };
  }
  async function readiness(oneTime: boolean) {
    vi.stubEnv('OPENSPELL_RECOMMENDATION_LANE_READY', oneTime ? '1' : undefined);
    vi.stubEnv('OPENSPELL_RECOMMENDATION_LANE_REVISION', oneTime ? revision : undefined);
    await database.sql`update app.recommendation_claim_authority set protocol=${oneTime ? 'fenced' : 'legacy'},
      admission=${oneTime ? 'scoped' : 'legacy'},authorized_revision=${oneTime ? revision : null},epoch=epoch+1 where singleton`;
    if (oneTime) {
      const sql = await database.sql.reserve();
      try {
        await sql.unsafe('set session authorization openspell_recommendation_worker');
        await sql`select public.report_recommendation_runtime('synthetic-mutation-worker',${revision},array[1,2],true)`;
      } finally { await sql.unsafe('reset session authorization'); sql.release(); }
    }
  }
  function input(kind: Kind, actor: Agency): Record<string, unknown> {
    if (kind === 'groupSave') return { profileId: actor.profileId, name: randomUUID(), role: 'profit',
      targetAcosPercent: 29, bidFloor: 0.17, bidCeiling: 3.19, bidIncreaseCapPercent: 13, bidDecreaseCapPercent: 31,
      placementIncreaseCapPercent: 11, placementDecreaseCapPercent: 27, exclusions: [], reviewWeekdays: ['monday'],
      prioritization: 'growth_first', enabled: true, campaignIds: ['c-1'] };
    if (kind === 'groupPreview') return { profileId: actor.profileId, groupId: actor.groupId };
    return { profileId: actor.profileId, clientRequestId: randomUUID(), scope: { mode: 'selected', campaignIds: ['c-1'] },
      ...(kind === 'oneTimePreview' ? { version: 1, configuration } : {}) };
  }
  function request(actor: Agency, body: unknown, authenticated = true) {
    return new Request('http://localhost/api/optimizer', { method: 'POST', body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', 'x-wizard-ads-auth-bridge': authenticated ? bridge : 'invalid',
        'x-wizard-ads-user-id': actor.userId, 'x-wizard-ads-org-id': actor.orgId } });
  }
  async function call(kind: Kind, actor: Agency, body: unknown, authenticated = true) {
    const response = await routes[kind](request(actor, body, authenticated));
    expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    expect(response.headers.get('vary')).toBe('Cookie, Authorization');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await database.sql`select pid from pg_stat_activity where datname=current_database() and application_name=${application}`).toEqual([]);
    return response;
  }
  async function counts(orgId: string) {
    const [result] = await database.sql<{ groups: number; batches: number; runs: number; scopes: number; jobs: number; audits: number }[]>`select
      (select count(*)::int from public.optimization_groups where org_id=${orgId}) as groups,
      (select count(*)::int from public.recommendation_preview_batches where org_id=${orgId}) as batches,
      (select count(*)::int from public.recommendation_runs where org_id=${orgId}) as runs,
      (select count(*)::int from public.recommendation_run_campaigns where org_id=${orgId}) as scopes,
      (select count(*)::int from public.sync_jobs where org_id=${orgId}) as jobs,
      (select count(*)::int from public.audit_log where org_id=${orgId}) as audits`;
    if (!result) throw new Error('Synthetic count query returned no row');
    return result;
  }

  it.each(Object.keys(routes) as Kind[])('%s counts accepted and denied roles across independent agencies', async (kind) => {
    // Historical fixture creation precedes fenced runtime activation; it is
    // setup, not a provider execution through the protected recommendation lane.
    await readiness(false);
    const cases = [];
    for (let cycle = 0; cycle < 3; cycle++) {
      for (const role of ['owner', 'admin', 'analyst', 'viewer'] as const) {
        const actor = await agency(); const other = await agency();
        await database.sql`update public.org_members set role=${role} where org_id=${actor.orgId} and user_id=${actor.userId}`;
        cases.push({ actor, other, role });
      }
    }
    await readiness(kind === 'oneTimePreview');
    let accepted = 0; let denied = 0;
    for (const { actor, other, role } of cases) {
      const before = await counts(actor.orgId); const foreign = await counts(other.orgId);
      const response = await call(kind, actor, input(kind, actor));
      if (role === 'viewer') {
        expect(response.status).toBe(403); denied++;
        expect(await counts(actor.orgId)).toEqual(before);
      } else {
        expect(response.status, await response.clone().text()).toBe(kind === 'groupSave' ? 200 : 202); accepted++;
        expect(await counts(actor.orgId)).toEqual({ ...before,
          groups: before.groups + Number(kind === 'groupSave'),
          batches: before.batches + Number(kind === 'batchPreview' || kind === 'oneTimePreview'),
          runs: before.runs + Number(kind !== 'groupSave'), scopes: before.scopes + Number(kind !== 'groupSave'),
          jobs: before.jobs + Number(kind !== 'groupSave'), audits: before.audits + Number(kind === 'groupSave' || kind === 'groupPreview') });
        if (kind === 'groupSave') expect(await response.json()).toMatchObject({ offeredCampaigns: 1, assignedCampaigns: 1 });
        if (kind === 'groupPreview') {
          const queued = await counts(actor.orgId);
          const repeated = await call(kind, actor, input(kind, actor));
          expect(repeated.status).toBe(409);
          expect(await repeated.json()).toMatchObject({ code: 'active_run_conflict' });
          expect(await counts(actor.orgId)).toEqual(queued);
        }
      }
      expect(await counts(other.orgId)).toEqual(foreign);
    }
    expect({ accepted, denied }).toEqual({ accepted: 9, denied: 3 });
  });

  it('keeps a dual-member actor in the selected agency and refuses foreign profile/group identities', async () => {
    await readiness(false);
    const actor = await agency(); const other = await agency();
    await database.sql`insert into public.org_members(org_id,user_id,role) values(${other.orgId},${actor.userId},'owner')`;
    const before = await counts(other.orgId);
    for (const kind of ['groupSave', 'groupPreview', 'batchPreview'] as const) {
      const response = await call(kind, actor, { ...input(kind, actor), profileId: other.profileId });
      expect([400, 404]).toContain(response.status);
    }
    expect((await call('groupPreview', actor, { ...input('groupPreview', actor), groupId: other.groupId })).status).toBe(404);
    const saved = await call('groupSave', actor, { ...input('groupSave', actor), orgId: other.orgId, actorId: other.userId, source: 'schedule' });
    expect(saved.status).toBe(200);
    const body = await saved.json() as { record: { group: { id: string } } };
    expect(await database.sql`select org_id,actor_id,source from public.audit_log where action='optimization_group.saved' and target_id=${body.record.group.id}`)
      .toEqual([{ org_id: actor.orgId, actor_id: actor.userId, source: 'web' }]);
    expect(await counts(other.orgId)).toEqual(before);
  });

  it('rejects malformed replacement settings without changing the saved group or assignments', async () => {
    const actor = await agency(); const valid = { ...input('groupSave', actor), id: actor.groupId };
    const snapshot = async () => ({
      groups: await database.sql`select * from public.optimization_groups where org_id=${actor.orgId}`,
      assignments: await database.sql`select * from public.campaign_optimization_assignments where org_id=${actor.orgId}`,
    });
    const before = await snapshot();
    for (const bad of [null, [], { ...valid, profileId: 'invalid' }, { ...valid, id: '' },
      { ...valid, enabled: 'false' }, { ...valid, targetAcosPercent: null }, { ...valid, targetAcosPercent: ' ' },
      { ...valid, campaignIds: ['c-1', ''] }, { ...valid, campaignIds: [' c-1'] }, { ...valid, campaignIds: ['c-1', 7] },
      { ...valid, reviewWeekdays: ['invalid'] }]) {
      expect((await call('groupSave', actor, bad)).status).toBe(400);
      expect(await snapshot()).toEqual(before);
    }
  });

  it('authenticates before creating a request pool and redacts actual SQL failures', async () => {
    const actor = await agency();
    const open = vi.spyOn(requestContext, 'openWebDatabase');
    try {
      for (const kind of Object.keys(routes) as Kind[]) expect((await call(kind, actor, input(kind, actor), false)).status).toBe(401);
      expect(open).not.toHaveBeenCalled();
    } finally { open.mockRestore(); }
    await database.sql`alter table public.optimization_groups rename column name to synthetic_inaccessible_name`;
    try {
      const response = await call('groupSave', actor, input('groupSave', actor));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'The change could not be confirmed. Reload to check its saved status before trying again.' });
    } finally { await database.sql`alter table public.optimization_groups rename column synthetic_inaccessible_name to name`; }
  });

  it('reports a lost close acknowledgement and reconciles the same one-time request without another job', async () => {
    await readiness(false); const actor = await agency(); const body = input('oneTimePreview', actor);
    await readiness(true);
    const before = await counts(actor.orgId); const realOpen = requestContext.openWebDatabase; let closes = 0;
    const open = vi.spyOn(requestContext, 'openWebDatabase').mockImplementation(() => {
      const handle = realOpen();
      return { ...handle, close: async () => { closes++; await handle.close(); throw new Error('synthetic lost close acknowledgement'); } };
    });
    try {
      const response = await call('oneTimePreview', actor, body);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'The preview request could not be reconciled. Retry with the same settings to check its saved status.' });
      expect(open).toHaveBeenCalledTimes(1); expect(closes).toBe(1);
    } finally { open.mockRestore(); }
    const committed = await counts(actor.orgId);
    expect(committed).toEqual({ ...before, batches: before.batches + 1, runs: before.runs + 1, scopes: before.scopes + 1, jobs: before.jobs + 1 });
    await database.sql`update app.recommendation_runtime_state set ready=false where singleton`;
    expect((await call('oneTimePreview', actor, body)).status).toBe(202);
    expect(await counts(actor.orgId)).toEqual(committed);
    expect((await call('oneTimePreview', actor, { ...body, configuration: { ...configuration, targetAcos: 0.39 } })).status).toBe(409);
    expect(await counts(actor.orgId)).toEqual(committed);
  });
});
