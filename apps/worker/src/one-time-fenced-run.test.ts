import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RecommendationWorkerDatabase } from '@wizard-ads/db/recommendation-worker';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import { RECOMMENDATION_EXECUTION_VERSIONS, type OneTimeRpcConfiguration } from '@wizard-ads/shared';
import { RecommendationClaimant } from './recommendation-lane/claimant.js';
import {
  createRecommendationsRunner, FencedRecommendationRunStore, PostgresRecommendationRunStore,
} from './recommendations-run.js';

const actorId = 'abababab-abab-4bab-8bab-abababababab';
const identity = { workerId: 'one-time-fenced-run-worker', revision: 'b'.repeat(40) };
const runAt = new Date('2026-09-01T12:00:00Z');
const configuration: OneTimeRpcConfiguration = {
  version: 1, method: 'rpc', targetAcos: 0.37,
  bidFloor: 0.11, bidCeiling: 4.3, bidIncreaseCap: 0.23, bidDecreaseCap: 0.41,
  window: { start: '2026-08-01', end: '2026-08-26' },
};
const available = await databaseAvailable();

describe.skipIf(!available)('one-time preview through the actual fenced runner', () => {
  let database: TestDatabase;
  let workerDatabase: RecommendationWorkerDatabase | undefined;
  let scope: { orgId: string; profileId: string };

  beforeEach(async () => {
    database = await createTestDatabase('one_time_fenced_run');
    const [tenant] = await database.sql<{ org_id: string }[]>`
      select app.seed_tenant_fixture('one-time-fenced-run', ${actorId}::uuid, 'owner', date '2026-08-26') as org_id
    `;
    const profiles = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${tenant!.org_id}::uuid
    `;
    expect(profiles).toHaveLength(1);
    scope = { orgId: tenant!.org_id, profileId: profiles[0]!.id };
    await database.sql`delete from public.profile_strategy where org_id = ${scope.orgId}::uuid`;
    await database.sql`delete from public.campaign_optimization_assignments where org_id = ${scope.orgId}::uuid`;
    // In-window RPC is 2: the confirmed ACOS yields a 0.74 bid from the current 0.90.
    await database.sql`
      update public.fact_sp_target_daily set clicks = 10, cost = 10, purchases_7d = 2, sales_7d = 20
       where org_id = ${scope.orgId}::uuid and profile_id = ${scope.profileId}::uuid
    `;
    // This later report must not leak into the saved window when execution happens days later.
    await database.sql`
      insert into public.fact_sp_target_daily
        (org_id, profile_id, date, ad_product, campaign_id, ad_group_id, target_id, target_kind,
         match_type, impressions, clicks, cost, purchases_7d, sales_7d, units_sold_7d)
      values (${scope.orgId}::uuid, ${scope.profileId}::uuid, date '2026-08-30', 'SP', 'c-1', 'ag-1',
              'kw-1', 'keyword', 'exact', 100, 10, 10, 2, 2000, 2)
    `;
  }, 60_000);

  afterEach(async () => {
    await workerDatabase?.close();
    workerDatabase = undefined;
    await database?.drop();
  });

  it('persists the positive RPC result with immutable settings, narrow custody, and reconciled counts', async () => {
    const serviceSession = await database.sql.reserve();
    try {
      await serviceSession`set session authorization service_role`;
      expect(await serviceSession`select decision from public.block_recommendation_admission(0)`)
        .toEqual([{ decision: 'blocked' }]);
      expect(await serviceSession`select decision from public.activate_recommendation_fenced_claims(1, ${identity.revision})`)
        .toEqual([{ decision: 'activated' }]);
      expect(await serviceSession`select decision from public.authorize_recommendation_scoped_admission(2, ${identity.revision})`)
        .toEqual([{ decision: 'authorized' }]);
    } finally {
      await serviceSession.unsafe('reset session authorization');
      serviceSession.release();
    }

    workerDatabase = new RecommendationWorkerDatabase({ ...identity, connectionString: database.connectionString });
    // The fixture role is NOLOGIN. Set the actual facade's single connection session identity
    // without changing cluster roles or replacing any production facade/runner method.
    const narrowSession = (workerDatabase as unknown as { readonly sql: TestDatabase['sql'] }).sql;
    await narrowSession`set session authorization openspell_recommendation_worker`;
    expect(await narrowSession`select session_user, current_user`).toEqual([{
      session_user: 'openspell_recommendation_worker', current_user: 'openspell_recommendation_worker',
    }]);
    await expect(narrowSession`select doc from public.profile_strategy`).rejects.toThrow(/permission denied/);
    await workerDatabase.reportRuntime(RECOMMENDATION_EXECUTION_VERSIONS, true);

    const admissionStore = new PostgresRecommendationRunStore(database);
    const accepted = await admissionStore.enqueueRecommendationPreviewBatch({
      ...scope, actorId, clientRequestId: randomUUID(), runAt,
      scope: { mode: 'selected', campaignIds: ['c-1'] }, oneTimeConfiguration: configuration,
    });
    expect(accepted).toMatchObject({ childCount: 1, scope: { campaignCount: 1 } });
    const queued = await database.sql<{
      id: string; job_id: string; scope_version: number; strategy_snapshot: unknown;
      strategy_goal: string | null; execution_snapshot: unknown; payload: unknown;
    }[]>`
      select run.id, run.job_id, run.scope_version, run.strategy_snapshot, run.strategy_goal,
             run.execution_snapshot, job.payload
        from public.recommendation_runs run join public.sync_jobs job on job.id = run.job_id
       where run.batch_id = ${accepted.batchId}::uuid
    `;
    expect(queued).toHaveLength(1);
    const saved = queued[0]!;
    expect(saved).toMatchObject({ scope_version: 2, strategy_snapshot: null, strategy_goal: null,
      execution_snapshot: { configuration, admittedAt: runAt.toISOString() },
      payload: { executionVersion: 2 } });
    expect(saved.payload).not.toHaveProperty('lookbackDays');

    const run = createRecommendationsRunner(new FencedRecommendationRunStore(workerDatabase), {
      now: () => new Date('2026-09-05T12:00:00Z'),
    });
    let executionError: unknown;
    const claimant = new RecommendationClaimant({
      identity, queue: workerDatabase, pollIntervalMs: 10, shutdownDrainMs: 1_000,
      execute: async (payload, execution) => {
        try { return await run(payload, execution); }
        catch (error) { executionError = error; throw error; }
      },
    });
    expect(await claimant.drainOnce()).toBe(1);
    if (executionError !== undefined) throw executionError;

    const results = await database.sql<{
      status: string; job_status: string; window_start: string; window_end: string;
      proposals_count: number; actual_count: number; attempts: number; claim_token: string | null;
      strategy_snapshot: unknown; strategy_goal: string | null; execution_snapshot: unknown; job_result: unknown;
    }[]>`
      select run.status, job.status as job_status, run.window_start::text, run.window_end::text,
             run.proposals_count, job.attempts, job.claim_token, run.strategy_snapshot,
             run.strategy_goal, run.execution_snapshot, job.result as job_result,
             (select count(*)::integer from public.recommendations where run_id = run.id) as actual_count
        from public.recommendation_runs run join public.sync_jobs job on job.id = run.job_id
       where run.id = ${saved.id}::uuid
    `;
    expect(results).toEqual([{
      status: 'succeeded', job_status: 'succeeded', window_start: configuration.window.start,
      window_end: configuration.window.end, proposals_count: 1, actual_count: 1,
      attempts: 1, claim_token: null, strategy_snapshot: null, strategy_goal: null,
      execution_snapshot: saved.execution_snapshot,
      job_result: { runId: saved.id, proposals: 1, window: configuration.window, alreadySucceeded: false },
    }]);
    const proposals = await database.sql<{
      entity_id: string; field: string; current_value: number; proposed_value: number; inputs: unknown;
    }[]>`
      select entity_id, field, current_value, proposed_value, inputs from public.recommendations
       where org_id = ${scope.orgId}::uuid and profile_id = ${scope.profileId}::uuid and run_id = ${saved.id}::uuid
    `;
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ entity_id: 'kw-1', field: 'bid', current_value: 0.9,
      proposed_value: 0.74, inputs: { rpc: 2, clicks: 10 } });
    const audits = await database.sql<{ narrative: unknown }[]>`
      select payload -> 'narrative' as narrative from public.audit_log
       where org_id = ${scope.orgId}::uuid and target_type = 'recommendation_run'
         and target_id = ${saved.id} and action = 'recommendation.run.succeeded'
    `;
    expect(audits).toHaveLength(1);
    expect(audits[0]?.narrative).toMatchObject({ window: configuration.window, oneTimeConfiguration: configuration,
      diagnostics: { targetsRead: 1, targetsConsidered: 1, proposed: 1, skippedMissingStrategy: 0 } });
    const status = await admissionStore.getRecommendationPreviewBatchStatus({ ...scope, batchId: accepted.batchId });
    expect(status).toMatchObject({ status: 'succeeded', campaignCount: 1, proposalsCount: 1,
      executionSnapshot: saved.execution_snapshot, children: [{ runId: saved.id, groupName: null,
        status: 'succeeded', outcome: 'completed', campaignCount: 1, proposalsCount: 1,
        diagnostics: { targetsRead: 1, targetsConsidered: 1, proposed: 1, skippedMissingStrategy: 0 } }] });
    expect(await claimant.drainOnce()).toBe(0);
    expect(await claimant.shutdown()).toEqual({ released: 0, unresolved: 0 });
  });
});
