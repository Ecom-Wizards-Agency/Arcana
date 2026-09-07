import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import { PostgresRecommendationRunStore } from '@wizard-ads/worker';
import { GET } from '../app/api/optimizer/runs/[batchId]/route';
import * as requestContext from './server/request-context';

const available = await databaseAvailable();
const bridge = 'synthetic-preview-status-bridge';
const application = 'synthetic-preview-status-' + randomUUID();
interface Agency { orgId: string; userId: string; profileId: string; batchId: string; runId: string }

describe.skipIf(!available)('actual agency preview-status reads', () => {
  let database: TestDatabase;
  const agencies: Agency[] = [];
  beforeAll(async () => {
    database = await createTestDatabase('preview_status_agency');
    for (let index = 0; index < 3; index++) {
      const userId = randomUUID();
      const [org] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture(${randomUUID()},${userId},'owner') as id`;
      const orgId = org!.id;
      const [batch] = await database.sql<{ id: string; profile_id: string }[]>`select id,profile_id from public.recommendation_preview_batches where org_id=${orgId}`;
      const [run] = await database.sql<{ id: string }[]>`select id from public.recommendation_runs where org_id=${orgId} and batch_id=${batch!.id}`;
      await database.sql`insert into public.audit_log(org_id,actor_id,actor_type,action,target_type,target_id,source,payload)
        values(${orgId},${userId},'service','recommendation.run.succeeded','recommendation_run',${run!.id},'worker',
        ${JSON.stringify({ narrative: { privateWorkerDetail: 'Synthetic detail must not be returned' } })}::jsonb)`;
      agencies.push({ orgId, userId, profileId: batch!.profile_id, batchId: batch!.id, runId: run!.id });
    }
    const url = new URL(database.connectionString); url.searchParams.set('application_name', application);
    vi.stubEnv('DATABASE_URL', url.toString());
    vi.stubEnv('WIZARD_ADS_E2E_AUTH_BRIDGE', '1');
    vi.stubEnv('WIZARD_ADS_AUTH_BRIDGE_SECRET', bridge);
  }, 60_000);
  afterAll(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await database?.drop(); });

  async function read(actor: Agency, target = actor, orgId = actor.orgId, profileId = target.profileId, batchId = target.batchId) {
    const url = new URL('/api/optimizer/runs/' + batchId, 'http://localhost');
    url.searchParams.set('profileId', profileId);
    const response = await GET(new Request(url, { headers: {
      'x-wizard-ads-auth-bridge': bridge, 'x-wizard-ads-user-id': actor.userId, 'x-wizard-ads-org-id': orgId,
    } }), { params: Promise.resolve({ batchId }) });
    expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    expect(response.headers.get('vary')).toContain('Cookie');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await database.sql`select pid from pg_stat_activity where datname=current_database() and application_name=${application}`).toEqual([]);
    return response;
  }

  it('preserves worker-store status counts while excluding other agencies and guessed scope', async () => {
    let responses = 0;
    for (const actor of agencies) {
      const actual = await read(actor); responses++;
      expect(actual.status).toBe(200);
      expect(await actual.json()).toEqual(await new PostgresRecommendationRunStore(database).getRecommendationPreviewBatchStatus(actor));
      for (const other of agencies.filter((agency) => agency !== actor)) {
        for (const [profile, batch] of [[other.profileId, other.batchId], [actor.profileId, other.batchId], [other.profileId, actor.batchId]]) {
          const response = await read(actor, other, actor.orgId, profile, batch); responses++;
          expect(response.status).toBe(404);
          expect(await response.json()).toEqual({ error: 'Not found' });
        }
        expect((await read(actor, other, other.orgId)).status).toBe(403); responses++;
      }
    }
    expect(responses).toBe(27);
  });

  it.each(['org_members', 'recommendation_preview_batches', 'recommendation_runs', 'sync_jobs', 'recommendation_run_campaigns', 'audit_log'])('reads %s under real authenticated RLS and sanitizes SQL errors', async (table) => {
    const privateDetail = 'synthetic-preview-sql-' + randomUUID();
    await database.sql.unsafe(`create function public.preview_status_failure() returns boolean language plpgsql as $$ begin raise exception '${privateDetail}'; end $$`);
    await database.sql`grant execute on function public.preview_status_failure() to authenticated`;
    await database.sql.unsafe(`create policy preview_status_failure on public.${table} as restrictive for select to authenticated using(public.preview_status_failure())`);
    try {
      await expect(database.sql`select public.preview_status_failure()`).rejects.toThrow(privateDetail);
      const response = await read(agencies[0]!);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'Could not load preview status. Try again.' });
    } finally {
      await database.sql.unsafe(`drop policy preview_status_failure on public.${table}`);
      await database.sql`drop function public.preview_status_failure()`;
    }
    expect((await read(agencies[0]!)).status).toBe(200);
  });

  it('retains exact selected membership for a viewer and refuses cached URLs after removal', async () => {
    const actor = agencies[0]!; const selected = agencies[1]!;
    await database.sql`insert into public.org_members(org_id,user_id,role) values(${selected.orgId},${actor.userId},'viewer')`;
    try {
      const response = await read(actor, selected, selected.orgId);
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain(selected.runId);
      expect(body).not.toContain(actor.runId);
      expect(body).not.toContain('privateWorkerDetail');
      expect((await read(actor, selected)).status).toBe(404);
    } finally { await database.sql`delete from public.org_members where org_id=${selected.orgId} and user_id=${actor.userId}`; }
    expect((await read(actor, selected, selected.orgId)).status).toBe(403);
  });

  it('preserves input refusals and hides missing run-scope rows as an integrity failure', async () => {
    const actor = agencies[0]!;
    expect((await read(actor, actor, actor.orgId, 'invalid')).status).toBe(400);
    expect((await read(actor, actor, actor.orgId, actor.profileId, 'invalid')).status).toBe(400);
    await database.sql`create policy preview_scope_hidden on public.recommendation_run_campaigns as restrictive for select to authenticated using(false)`;
    try {
      const response = await read(actor);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Recommendation preview evidence failed its integrity check.', code: 'integrity_failure' });
    } finally { await database.sql`drop policy preview_scope_hidden on public.recommendation_run_campaigns`; }
  });

  it('verifies identity before opening a connection and refuses a failed final close', async () => {
    const identify = vi.spyOn(requestContext, 'requestActor').mockRejectedValue(new requestContext.RequestAuthError('Authentication required', 401));
    const originalOpen = requestContext.openWebDatabase;
    const open = vi.spyOn(requestContext, 'openWebDatabase');
    try {
      expect((await read(agencies[0]!)).status).toBe(401);
      expect(open).not.toHaveBeenCalled();
    } finally { identify.mockRestore(); open.mockRestore(); }
    let closes = 0;
    const failingOpen = vi.spyOn(requestContext, 'openWebDatabase').mockImplementation(() => {
      const handle = originalOpen();
      return { ...handle, close: async () => { closes++; await handle.close(); throw new Error('Synthetic private teardown failure'); } };
    });
    try {
      const response = await read(agencies[0]!);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'Could not load preview status. Try again.' });
      expect(closes).toBe(1);
    } finally { failingOpen.mockRestore(); }
  });
});
