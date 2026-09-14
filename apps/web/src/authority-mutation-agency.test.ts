import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@wizard-ads/db/testing';
import { createExperiment, listExperimentEvents, mutateExperimentForActor, loadContextualNegativeReview,
  exportAcceptedContextualNegatives, withAuthenticatedOrgEditor, type QueryHandle } from '@wizard-ads/db';
import { issueMcpKey } from './data/mcp-keys';
import { requireOrgRole } from './server/org-role';
import * as requestContext from './server/request-context';
import { POST as createExperimentRoute } from '../app/api/experiments/route';
import { PATCH as patchExperiment } from '../app/api/experiments/[experimentId]/route';
import { POST as decide } from '../app/api/recommendations/decide/route';
import { POST as exportRecs } from '../app/api/recommendations/export/route';
import { POST as propose } from '../app/api/ngrams/negatives/route';
import { POST as decideQuery } from '../app/api/query-intelligence/negatives/decide/route';
import { POST as exportQuery } from '../app/api/query-intelligence/negatives/export/route';
import { POST as revert } from '../app/api/time-machine/reversion/route';
import { POST as issue } from '../app/api/mcp-keys/route';
import { POST as revoke } from '../app/api/mcp-keys/[keyId]/revoke/route';
import { GET as recDownload } from '../app/api/recommendations/export/[batchId]/route';
import { GET as queryDownload } from '../app/api/query-intelligence/negatives/export/[exportId]/route';
import { GET as daypartDownload } from '../app/api/dayparting/export/route';
import { POST as campaignBuild } from '../app/api/campaigns/build/route';
import { GET as gridRows } from '../app/api/grid/rows/route';
import { GET as optimizerStatus } from '../app/api/optimizer/runs/[batchId]/route';

const mutations = ['experimentCreate','experimentPatch','recommendationDecide','recommendationExport','ngramPropose',
  'queryDecide','queryExport','reversion','keyIssue','keyRevoke'] as const;
const reads = ['recommendationDownload','queryDownload','daypartingDownload','campaignBuild','optimizerStatus','gridRows'] as const;
type Kind = typeof mutations[number] | typeof reads[number];
interface Agency { orgId: string; userId: string; profileId: string; experimentId: string; recommendationId: string;
  runId: string; batchId: string; queryId: string; exportId: string; daypartId: string; previewId: string; keyId: string }
const bridge = 'synthetic-authority-agency-bridge';
const application = 'synthetic-authority-' + randomUUID();
const market = 'SYNTHETIC_REVIEW';
const pauseKey = 253987;

describe('WP-253 agency authority', () => {
  let database: TestDatabase;
  const agencies: Agency[] = [];
  beforeAll(async () => {
    database = await createTestDatabase('authority_agency');
    for (let index = 0; index < 3; index++) {
      const userId = randomUUID();
      const [org] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture(${randomUUID()},${userId},'owner') as id`;
      const orgId = org!.id;
      const [profile] = await database.sql<{ id: string }[]>`select id from public.ad_profiles where org_id=${orgId}`;
      const profileId = profile!.id;
      const [experiment] = await database.sql<{ id: string }[]>`select id from public.experiments where org_id=${orgId}`;
      const [recommendation] = await database.sql<{ id: string; run_id: string }[]>`select id,run_id from public.recommendations where org_id=${orgId}`;
      const [batch] = await database.sql<{ id: string }[]>`select id from public.apply_batches where org_id=${orgId}`;
      const [daypart] = await database.sql<{ id: string }[]>`select id from public.dayparting_schedule_proposals where org_id=${orgId}`;
      const [preview] = await database.sql<{ id: string }[]>`select id from public.recommendation_preview_batches where org_id=${orgId}`;
      const [query] = await database.sql<{ id: string }[]>`insert into public.contextual_negative_proposals
        (org_id,profile_id,marketplace_id,campaign_id,ad_group_id,search_term,normalized_query,category,source_group_role,match_type,reason,status)
        values(${orgId},${profileId},${market},'c-1','ag-1','Synthetic query','synthetic query','excluded','profit','negative_exact','Synthetic evidence','accepted') returning id`;
      const loaded = await loadContextualNegativeReview(database, { orgId, profileId, marketplaceId: market });
      if (loaded.status !== 'ready') throw new Error('Fixture review not ready');
      const exported = await exportAcceptedContextualNegatives(database, { orgId, profileId, marketplaceId: market,
        proposals: loaded.proposals.map((p) => ({ id: p.id, expectedFingerprint: p.reviewFingerprint })), actorId: userId, note: 'Synthetic export' });
      const key = await issueMcpKey(database, { orgId, createdBy: userId, label: 'Synthetic key', profileIds: [profileId], expiresInDays: 7 });
      agencies.push({ orgId, userId, profileId, experimentId: experiment!.id, recommendationId: recommendation!.id, runId: recommendation!.run_id,
        batchId: batch!.id, queryId: query!.id, exportId: exported.exportId, daypartId: daypart!.id, previewId: preview!.id, keyId: key.record.id });
    }
    const url = new URL(database.connectionString); url.searchParams.set('application_name', application);
    vi.stubEnv('DATABASE_URL', url.toString()); vi.stubEnv('WIZARD_ADS_APP_URL', 'http://localhost');
    vi.stubEnv('WIZARD_ADS_E2E_AUTH_BRIDGE', '1'); vi.stubEnv('WIZARD_ADS_AUTH_BRIDGE_SECRET', bridge);
  }, 60_000);
  afterAll(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await database?.drop(); });

  function request(actor: Agency, path: string, body?: unknown, method = 'POST') {
    return new Request('http://localhost/api/' + path, { method: body === undefined ? 'GET' : method,
      headers: { origin: 'http://localhost', 'content-type': 'application/json', 'x-wizard-ads-auth-bridge': bridge,
        'x-wizard-ads-user-id': actor.userId, 'x-wizard-ads-org-id': actor.orgId },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function call(kind: Kind, actor: Agency, target = actor): Promise<Response> {
    const selection = { profileId: target.profileId, marketplaceId: market,
      proposals: [{ id: target.queryId, expectedFingerprint: 'a'.repeat(64) }], note: 'Synthetic review' };
    switch (kind) {
      case 'experimentCreate': return createExperimentRoute(request(actor,'experiments',{ profileId: target.profileId, name: 'Synthetic new', type: 'bid_push', metricFocus: 'sales' }));
      case 'experimentPatch': return patchExperiment(request(actor,'experiments',{ name: 'Synthetic edited' },'PATCH'),{ params: Promise.resolve({ experimentId: target.experimentId }) });
      case 'recommendationDecide': return decide(request(actor,'recommendations/decide',{ ids: [target.recommendationId], decision: 'accepted' }));
      case 'recommendationExport': return exportRecs(request(actor,'recommendations/export',{ runId: target.runId, profileId: target.profileId, note: 'Synthetic export' }));
      case 'ngramPropose': return propose(request(actor,'ngrams/negatives',{ profileId: target.profileId, window: { start: '2026-07-01', end: '2026-07-02' }, proposals: [{ searchTerm: 'Synthetic term', campaignId: 'c-1', adGroupId: 'ag-1' }] }));
      case 'queryDecide': return decideQuery(request(actor,'query-intelligence/negatives/decide',{ ...selection, decision: 'accepted' }));
      case 'queryExport': return exportQuery(request(actor,'query-intelligence/negatives/export',{ ...selection, confirmed: true }));
      case 'reversion': return revert(request(actor,'time-machine/reversion',{ batchId: target.batchId, profileId: target.profileId, expectedRows: 1, note: 'Synthetic inverse', confirmation: 'Yes, export reversion' }));
      case 'keyIssue': return issue(request(actor,'mcp-keys',{ label: 'Synthetic key', profileIds: [target.profileId], expiresInDays: 7 }));
      case 'keyRevoke': return revoke(request(actor,'mcp-keys/revoke',{}),{ params: Promise.resolve({ keyId: target.keyId }) });
      case 'recommendationDownload': return recDownload(request(actor,'recommendations/export?format=rows'),{ params: Promise.resolve({ batchId: target.batchId }) });
      case 'queryDownload': return queryDownload(request(actor,'query-intelligence/negatives/export?format=csv'),{ params: Promise.resolve({ exportId: target.exportId }) });
      case 'daypartingDownload': return daypartDownload(request(actor,`dayparting/export?id=${target.daypartId}&profileId=${target.profileId}&format=json`));
      case 'campaignBuild': return campaignBuild(request(actor,'campaigns/build',{ mode: 'update', output: 'preview', profileId: target.profileId, config: { changes: { campaigns: [{ campaignId: 'c-1', dailyBudget: 25 }] } } }));
      case 'gridRows': {
        const query = new URLSearchParams({ profile: target.profileId, entity: 'targets', from: '2026-07-01', to: '2026-07-02' });
        return gridRows(request(actor,'grid/rows?' + query.toString()));
      }
      case 'optimizerStatus': return optimizerStatus(request(actor,`optimizer/runs/status?profileId=${target.profileId}`),{ params: Promise.resolve({ batchId: target.previewId }) });
    }
  }
  async function snapshot() {
    const tables = ['experiments','experiment_events','recommendations','recommendation_runs','apply_batches','apply_rows','contextual_negative_proposals','contextual_negative_exports','audit_log'];
    const result = [];
    for (const table of tables) result.push(await database.sql.unsafe(`select to_jsonb(t) as row from public.${table} t order by to_jsonb(t)::text`));
    result.push(await database.sql`select id,org_id,revoked_at from mcp.api_keys order by id`);
    return result;
  }
  async function waitForBlocked() {
    for (let attempt = 0; attempt < 200; attempt++) {
      const rows = await database.sql`select pid from pg_stat_activity where datname=current_database()
        and application_name=${application} and cardinality(pg_blocking_pids(pid))>0`;
      if (rows.length === 1) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('The request never reached its database lock');
  }
  function guessed(target: Agency): Agency {
    return { ...target, profileId: randomUUID(), experimentId: randomUUID(), recommendationId: randomUUID(), runId: randomUUID(),
      batchId: randomUUID(), queryId: randomUUID(), exportId: randomUUID(), daypartId: randomUUID(), previewId: randomUUID(), keyId: randomUUID() };
  }

  it.each([...mutations,...reads])('%s isolates unrelated agencies, dual memberships and guessed IDs', async (kind) => {
    const before = await snapshot(); let refused = 0;
    for (let index = 0; index < agencies.length; index++) {
      const actor = agencies[index]!; const other = agencies[(index+1)%agencies.length]!;
      expect((await call(kind, { ...actor, orgId: other.orgId }, other)).status).toBe(403); refused++;
      await database.sql`insert into public.org_members(org_id,user_id,role) values(${other.orgId},${actor.userId},'admin')`;
      try {
        for (const target of [other,guessed(other)]) {
          const response = await call(kind, actor, target);
          if (kind === 'recommendationDecide') {
            expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ offered: 1, updated: 0 });
          } else expect([400,404,409]).toContain(response.status);
          refused++;
        }
      } finally { await database.sql`delete from public.org_members where org_id=${other.orgId} and user_id=${actor.userId}`; }
    }
    expect(refused).toBe(9); expect(await snapshot()).toEqual(before);
  });

  it.each(mutations)('%s observes a role revoked while its membership lock waits', async (kind) => {
    const actor = agencies[0]!; const before = await snapshot(); let pending: Promise<Response> | undefined;
    await database.sql.begin(async (sql) => {
      await sql`update public.org_members set role='viewer' where org_id=${actor.orgId} and user_id=${actor.userId}`;
      pending = call(kind, actor);
      await waitForBlocked();
    });
    try { expect((await pending!).status).toBe(403); expect(await snapshot()).toEqual(before); }
    finally { await database.sql`update public.org_members set role='owner' where org_id=${actor.orgId} and user_id=${actor.userId}`; }
  });

  it.each(reads.filter((kind) => kind !== 'gridRows'))('%s holds one read-only snapshot without blocking membership revocation', async (kind) => {
    const actor = agencies[0]!;
    const baseline = await call(kind, actor); expect(baseline.status).toBe(200);
    const expected = await baseline.text();
    await database.sql.unsafe(`create function public.authority_read_pause() returns boolean language plpgsql as $$ begin perform pg_advisory_xact_lock(${pauseKey}); return true; end $$`);
    await database.sql`grant execute on function public.authority_read_pause() to authenticated`;
    await database.sql`create policy authority_read_pause on public.org_members as restrictive for select to authenticated using(public.authority_read_pause())`;
    let pending: Promise<Response> | undefined;
    try {
      await database.sql.begin(async (sql) => {
        await sql`select pg_advisory_xact_lock(${pauseKey})`;
        pending = call(kind, actor); await waitForBlocked();
        await database.sql`delete from public.org_members where org_id=${actor.orgId} and user_id=${actor.userId}`;
      });
      const response = await pending!; expect(response.status).toBe(200); expect(await response.text()).toBe(expected);
      expect((await call(kind, actor)).status).toBe(403);
    } finally {
      await database.sql`drop policy authority_read_pause on public.org_members`;
      await database.sql`drop function public.authority_read_pause()`;
      await database.sql`insert into public.org_members(org_id,user_id,role) values(${actor.orgId},${actor.userId},'owner') on conflict do nothing`;
    }
  });

  it('refuses an illegal experiment transition and records only real status moves', async () => {
    const actor = agencies[0]!;
    const item = await createExperiment(database,{ orgId: actor.orgId, profileId: actor.profileId, createdBy: actor.userId, name: 'Synthetic lifecycle', type: 'other', metricFocus: 'sales' });
    const events = () => listExperimentEvents(database,{ orgId: actor.orgId, experimentId: item.id });
    const before = await events(); expect(before).toHaveLength(1);
    await expect(mutateExperimentForActor(database,{ orgId: actor.orgId, userId: actor.userId },{ kind: 'transition',experimentId: item.id,status: 'analyzed' })).rejects.toMatchObject({ code: 'conflict' });
    expect(await events()).toEqual(before);
    const note = await mutateExperimentForActor(database,{ orgId: actor.orgId, userId: actor.userId },{ kind: 'transition',experimentId: item.id,resultNote: 'Synthetic note' });
    expect(note.event).toBeNull(); expect(await events()).toHaveLength(1);
    const results = await Promise.all([1,2].map(() => mutateExperimentForActor(database,{ orgId: actor.orgId, userId: actor.userId },{ kind: 'transition',experimentId: item.id,status: 'running' })));
    expect(results.filter((r) => r.event !== null)).toHaveLength(1); expect(await events()).toHaveLength(2);
  });

  it('rolls back failed experiment readback and rejects a widened service-role handle', async () => {
    const actor = agencies[0]!; const before = await snapshot();
    // Corrupt only the returned creation event; parsing must prevent its commit.
    await database.sql`create function public.authority_bad_event() returns trigger language plpgsql as $$ begin new.from_status:='planned'; return new; end $$`;
    await database.sql`create trigger authority_bad_event before insert on public.experiment_events for each row execute function public.authority_bad_event()`;
    try {
      const response = await call('experimentCreate',actor); expect(response.status).toBe(503); expect(await snapshot()).toEqual(before);
    } finally { await database.sql`drop trigger authority_bad_event on public.experiment_events`; await database.sql`drop function public.authority_bad_event()`; }
    const widened: QueryHandle = database;
    await expect(requireOrgRole(widened,actor)).rejects.toMatchObject({ status: 403 });
    // @ts-expect-error A concrete service-role RequestDatabase is not a transaction.
    await expect(requireOrgRole(database,actor)).rejects.toMatchObject({ status: 403 });
    expect(await withAuthenticatedOrgEditor(database,{ orgId: actor.orgId, userId: actor.userId },(context) => requireOrgRole(context))).toBe('owner');
  });

  it('opens at most one authenticated transaction per changed mutation request', async () => {
    const original = requestContext.openWebDatabase;
    for (const kind of mutations) {
      let transactions = 0;
      const open = vi.spyOn(requestContext,'openWebDatabase').mockImplementation(() => {
        const handle = original(); const begin = handle.sql.begin;
        vi.spyOn(handle.sql,'begin').mockImplementation((...args) => { transactions++; return Reflect.apply(begin,handle.sql,args); });
        return handle;
      });
      try { await call(kind,{ ...agencies[0]!, userId: randomUUID() }); expect(transactions).toBe(1); expect(open).toHaveBeenCalledTimes(1); }
      finally { open.mockRestore(); }
    }
  });
});
