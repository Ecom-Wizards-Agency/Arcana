import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import { OneTimeRecommendationsRunJob, type OneTimeRpcConfiguration } from '@wizard-ads/shared';
import {
  createRecommendationsRunner, PostgresRecommendationRunStore,
} from './recommendations-run.js';
import { PostgresWorkerStore } from './store.js';
import { SyncWorker } from './worker.js';

const actorId = 'abababab-abab-4bab-8bab-abababababab';
const configuration: OneTimeRpcConfiguration = {
  version: 1, method: 'rpc', targetAcos: 0.37,
  bidFloor: 0.11, bidCeiling: 4.3, bidIncreaseCap: 0.23, bidDecreaseCap: 0.41,
  window: { start: '2026-08-01', end: '2026-08-26' },
};
const runAt = new Date('2026-09-01T12:00:00Z');
const revision = 'b'.repeat(40);
const available = await databaseAvailable();

describe.skipIf(!available)('one-time preview persisted admission and execution', () => {
  let database: TestDatabase;
  let store: PostgresRecommendationRunStore;
  let scope: { orgId: string; profileId: string; groupId: string };

  beforeEach(async () => {
    // Exercise format/store compatibility before the separate runtime activation gate.
    database = await createTestDatabase('one_time_admission', { throughMigration: '20260907000000_one_time_rpc_previews.sql' });
    store = new PostgresRecommendationRunStore(database);
    const [row] = await database.sql<{ org_id: string }[]>`
      select app.seed_tenant_fixture('one-time-synthetic', ${actorId}::uuid, 'owner', date '2026-08-26') as org_id
    `;
    const [profile] = await database.sql<{ id: string }[]>`select id from public.ad_profiles where org_id = ${row!.org_id}::uuid`;
    const [group] = await database.sql<{ id: string }[]>`select id from public.optimization_groups where org_id = ${row!.org_id}::uuid`;
    scope = { orgId: row!.org_id, profileId: profile!.id, groupId: group!.id };
    await database.sql`delete from public.profile_strategy where org_id = ${scope.orgId}::uuid`;
  }, 60_000);
  afterEach(async () => { await database?.drop(); });

  function request() {
    return { orgId: scope.orgId, profileId: scope.profileId, actorId, clientRequestId: randomUUID(),
      scope: { mode: 'selected' as const, campaignIds: ['c-1'] }, oneTimeConfiguration: configuration, runAt };
  }

  async function child(batchId: string) {
    const rows = await database.sql<{
      id: string; job_id: string; scope_version: number; scope_count: number;
      strategy_snapshot: unknown; execution_snapshot: unknown; payload: unknown;
    }[]>`
      select run.id, run.job_id, run.scope_version, run.scope_count, run.strategy_snapshot,
             run.execution_snapshot, job.payload
        from public.recommendation_runs run join public.sync_jobs job on job.id = run.job_id
       where run.batch_id = ${batchId}::uuid
    `;
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  it('serializes retry races, freezes the original admission, and refuses changed settings', async () => {
    const input = request();
    const results = await Promise.all([
      store.enqueueRecommendationPreviewBatch(input), store.enqueueRecommendationPreviewBatch(input),
    ]);
    expect(results[0]).toEqual(results[1]);
    const accepted = results[0]!;
    expect(accepted).toMatchObject({ childCount: 1, scope: { campaignCount: 1 } });
    const original = await child(accepted.batchId);
    expect(original).toMatchObject({ scope_version: 2, scope_count: 1, strategy_snapshot: null,
      execution_snapshot: { configuration, admittedAt: runAt.toISOString() } });
    expect(OneTimeRecommendationsRunJob.parse(original.payload)).toMatchObject({ executionVersion: 2 });
    expect(original.payload).not.toHaveProperty('lookbackDays');
    expect(await store.enqueueRecommendationPreviewBatch({ ...input, runAt: new Date('2026-09-03T00:00:00Z') })).toEqual(accepted);
    expect(await child(accepted.batchId)).toEqual(original);
    await expect(store.enqueueRecommendationPreviewBatch({ ...input,
      oneTimeConfiguration: { ...configuration, targetAcos: 0.39 },
    })).rejects.toMatchObject({ code: 'idempotency_conflict' });
    const [count] = await database.sql<{ count: number }[]>`
      select count(*)::integer as count from public.recommendation_preview_batches
       where org_id = ${scope.orgId}::uuid and client_request_id = ${input.clientRequestId}::uuid
    `;
    expect(count?.count).toBe(1);
    await expect(database.sql`
      update public.recommendation_runs set execution_snapshot = jsonb_set(execution_snapshot,
        '{configuration,targetAcos}', '0.39'::jsonb) where id = ${original.id}::uuid
    `).rejects.toThrow(/immutable/);
    const [closure] = await database.sql<{ closes: boolean }[]>`
      select app.recommendation_job_scope_closes(${original.job_id}::uuid) as closes
    `;
    expect(closure?.closes).toBe(true);
  });

  it.each(['assigned', 'unassigned', 'disabled-strategy'])('executes the frozen window without saved strategy (%s)', async (assignment) => {
    if (assignment === 'unassigned') await database.sql`delete from public.campaign_optimization_assignments where org_id = ${scope.orgId}::uuid`;
    if (assignment === 'disabled-strategy') await database.sql`update public.optimization_groups set enabled = false where id = ${scope.groupId}::uuid`;
    const accepted = await store.enqueueRecommendationPreviewBatch(request());
    const queued = await child(accepted.batchId);
    const worker = new SyncWorker({ workerId: 'one-time-compatible-worker', store: new PostgresWorkerStore(database, { info: () => {} }),
      jobTypes: ['recommendations.run'], recommendationsRun: createRecommendationsRunner(store, { now: () => new Date('2026-09-05T12:00:00Z') }),
      logger: { info: () => {}, error: () => {} } });
    expect(await worker.drainOnce()).toBe(1);
    const [result] = await database.sql<{
      status: string; job_status: string; window_start: string; window_end: string; proposals_count: number; actual_count: number;
    }[]>`
      select run.status, job.status as job_status, run.window_start::text, run.window_end::text, run.proposals_count,
        (select count(*)::integer from public.recommendations where run_id = run.id) as actual_count
        from public.recommendation_runs run join public.sync_jobs job on job.id = run.job_id where run.id = ${queued.id}::uuid
    `;
    expect(result).toMatchObject({ status: 'succeeded', job_status: 'succeeded',
      window_start: configuration.window.start, window_end: configuration.window.end });
    expect(result?.proposals_count).toBeGreaterThan(0);
    expect(result?.actual_count).toBe(result?.proposals_count);
    const status = await store.getRecommendationPreviewBatchStatus({ orgId: scope.orgId, profileId: scope.profileId, batchId: accepted.batchId });
    expect(status).toMatchObject({ status: 'succeeded', campaignCount: 1, proposalsCount: result?.actual_count });
  });

  it('blocks overlapping manual and scheduled admissions after reassignment and rejects foreign selections', async () => {
    // The immutable old scope is unassigned; it moves into a scheduled group after admission.
    await database.sql`delete from public.campaign_optimization_assignments where org_id = ${scope.orgId}::uuid`;
    await store.enqueueRecommendationPreviewBatch(request());
    await database.sql`insert into public.campaign_optimization_assignments (org_id, profile_id, campaign_id, group_id, assigned_by)
      values (${scope.orgId}::uuid, ${scope.profileId}::uuid, 'c-1', ${scope.groupId}::uuid, ${actorId}::uuid)`;
    await expect(store.enqueueRecommendationPreviewBatch(request())).rejects.toMatchObject({ code: 'active_run_conflict' });
    await expect(store.enqueueRecommendationRun({ ...scope, source: 'web' })).rejects.toThrow(/overlaps/);
    const [before] = await database.sql<{ next_run_at: Date | null }[]>`select next_run_at from public.optimization_groups where id = ${scope.groupId}::uuid`;
    expect(await store.enqueueDueRecommendationRuns(new Date('2026-10-01T12:00:00Z'))).toBe(0);
    const [after] = await database.sql<{ next_run_at: Date | null }[]>`select next_run_at from public.optimization_groups where id = ${scope.groupId}::uuid`;
    expect(after).toEqual(before);
    await expect(store.enqueueRecommendationPreviewBatch({ ...request(), scope: { mode: 'selected', campaignIds: ['foreign-campaign'] } }))
      .rejects.toMatchObject({ code: 'stale_selection' });
    await expect(store.enqueueRecommendationPreviewBatch({ ...request(), profileId: randomUUID() }))
      .rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('closes an ungrouped snapshot through the actual worker session and fenced RPCs', async () => {
    await database.sql`delete from public.campaign_optimization_assignments where org_id = ${scope.orgId}::uuid`;
    await database.sql`update app.recommendation_claim_authority
      set protocol = 'fenced', admission = 'scoped', authorized_revision = ${revision}, epoch = epoch + 1 where singleton`;
    const accepted = await store.enqueueRecommendationPreviewBatch(request());
    const queued = await child(accepted.batchId);
    const sql = await database.sql.reserve();
    try {
      // The same disposable session switch used by the custody migration suite.
      // SET ROLE is insufficient: the boundary checks the connection identity.
      await sql.unsafe('set session authorization openspell_recommendation_worker');
      await expect(sql`select app.recommendation_campaign_safety(${scope.orgId}::uuid, ${scope.profileId}::uuid, array['c-1'])`)
        .rejects.toThrow(/permission denied/);
      const claims = await sql<{ id: string; claim_token: string }[]>`
        select id, claim_token from public.claim_recommendation_jobs_fenced('one-time-fenced', ${revision}, 1)
      `;
      expect(claims).toHaveLength(1);
      const claim = claims[0]!;
      expect(claim.id).toBe(queued.job_id);
      const started = await sql<{ decision: string; run_data: unknown }[]>`
        select decision, run_data from public.start_recommendation_run_fenced(
          ${claim.id}::uuid, 'one-time-fenced', ${claim.claim_token}::uuid, ${revision},
          ${scope.orgId}::uuid, ${scope.profileId}::uuid, ${queued.id}::uuid, null)
      `;
      expect(started).toHaveLength(1);
      expect(started[0]).toMatchObject({ decision: 'started', run_data: {
        scopeVersion: 2, strategySnapshot: null, executionSnapshot: { configuration },
      } });
      await expect(sql`select * from public.read_recommendation_inputs_fenced(
        ${claim.id}::uuid, 'one-time-fenced', ${claim.claim_token}::uuid, ${revision},
        ${scope.orgId}::uuid, ${scope.profileId}::uuid, ${queued.id}::uuid, null,
        date '2026-08-02', date '2026-08-27')`).rejects.toThrow(/window/);
      const input = await sql<{ inputs: { targets: unknown[] }; group_safety: unknown }[]>`
        select inputs, group_safety from public.read_recommendation_inputs_fenced(
          ${claim.id}::uuid, 'one-time-fenced', ${claim.claim_token}::uuid, ${revision},
          ${scope.orgId}::uuid, ${scope.profileId}::uuid, ${queued.id}::uuid, null,
          ${configuration.window.start}::date, ${configuration.window.end}::date)
      `;
      expect(input).toHaveLength(1);
      expect(input[0]?.group_safety).toMatchObject({ mayPropose: true, exportedRecommendations: 0 });
      expect(input[0]?.inputs.targets).toHaveLength(1);
      const completion = { lookbackDays: 26, window: configuration.window, strategySnapshot: null,
        proposals: [], narrative: { oneTimeConfiguration: configuration } };
      const completed = await sql<{ decision: string; proposals_count: number }[]>`
        select decision, proposals_count from public.succeed_recommendation_run_fenced(
          ${claim.id}::uuid, 'one-time-fenced', ${claim.claim_token}::uuid, ${revision},
          ${scope.orgId}::uuid, ${scope.profileId}::uuid, ${queued.id}::uuid, null, ${JSON.stringify(completion)}::jsonb)
      `;
      expect(completed).toEqual([{ decision: 'succeeded', proposals_count: 0 }]);
      const finished = await sql<{ decision: string; status: string }[]>`
        select decision, status from public.finish_recommendation_job_fenced(
          ${claim.id}::uuid, 'one-time-fenced', ${claim.claim_token}::uuid, ${revision},
          'succeeded', null, '{}'::jsonb, null)
      `;
      expect(finished).toEqual([{ decision: 'settled', status: 'succeeded' }]);
    } finally {
      await sql.unsafe('reset session authorization');
      sql.release();
    }
  });
});
