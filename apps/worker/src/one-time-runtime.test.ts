import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import type { OneTimeRpcConfiguration } from '@wizard-ads/shared';
import { PostgresRecommendationRunStore } from './recommendations-run.js';

const actorId = 'abababab-abab-4bab-8bab-abababababab';
const revision = 'b'.repeat(40);
const oldRevision = 'a'.repeat(40);
const workerId = 'one-time-runtime-worker';
const runAt = new Date('2026-09-01T12:00:00Z');
const configuration: OneTimeRpcConfiguration = {
  version: 1, method: 'rpc', targetAcos: 0.37,
  bidFloor: 0.11, bidCeiling: 4.3, bidIncreaseCap: 0.23, bidDecreaseCap: 0.41,
  window: { start: '2026-08-01', end: '2026-08-26' },
};
type SessionSql = Awaited<ReturnType<TestDatabase['sql']['reserve']>>;
type Scope = { orgId: string; profileId: string; groupId: string };
type Claim = { id: string; claim_token: string; attempts: number };
const available = await databaseAvailable();

describe.skipIf(!available)('one-time runtime admission and claim compatibility', () => {
  let database: TestDatabase;
  let store: PostgresRecommendationRunStore;
  let scope: Scope;

  beforeEach(async () => {
    database = await createTestDatabase('one_time_runtime');
    store = new PostgresRecommendationRunStore(database);
    scope = await seed('one-time-runtime');
  }, 60_000);
  afterEach(async () => { await database?.drop(); });

  async function seed(slug: string): Promise<Scope> {
    const [tenant] = await database.sql<{ org_id: string }[]>`
      select app.seed_tenant_fixture(${slug}, ${actorId}::uuid, 'owner', date '2026-08-26') as org_id
    `;
    const profiles = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${tenant!.org_id}::uuid
    `;
    const groups = await database.sql<{ id: string }[]>`
      select id from public.optimization_groups where org_id = ${tenant!.org_id}::uuid
    `;
    expect(profiles).toHaveLength(1);
    expect(groups).toHaveLength(1);
    return { orgId: tenant!.org_id, profileId: profiles[0]!.id, groupId: groups[0]!.id };
  }

  async function asSession<T>(role: string, fn: (sql: SessionSql) => Promise<T>): Promise<T> {
    const sql = await database.sql.reserve();
    try {
      // These RPCs check session_user. SET ROLE and URL startup options do not prove that boundary.
      await sql`set session authorization ${sql(role)}`;
      const [identity] = await sql<{ session_user: string }[]>`select session_user`;
      expect(identity?.session_user).toBe(role);
      return await fn(sql);
    } finally {
      await sql.unsafe('reset session authorization');
      sql.release();
    }
  }

  async function activate() {
    await asSession('service_role', async (sql) => {
      expect(await sql`select decision from public.block_recommendation_admission(0)`)
        .toEqual([{ decision: 'blocked' }]);
      expect(await sql`select decision from public.activate_recommendation_fenced_claims(1, ${revision})`)
        .toEqual([{ decision: 'activated' }]);
      expect(await sql`select decision from public.authorize_recommendation_scoped_admission(2, ${revision})`)
        .toEqual([{ decision: 'authorized' }]);
    });
  }

  async function rebind(from: string, to: string) {
    await asSession('service_role', async (sql) => {
      const [authority] = await sql<{ epoch: string }[]>`select epoch from public.get_recommendation_claim_authority()`;
      const [blocked] = await sql<{ decision: string; epoch: string }[]>`
        select decision, epoch from public.block_recommendation_admission(${authority!.epoch}::bigint)
      `;
      expect(blocked?.decision).toBe('blocked');
      const [rebound] = await sql<{ decision: string; epoch: string }[]>`
        select decision, epoch from public.rebind_recommendation_fenced_revision(${blocked!.epoch}::bigint, ${from}, ${to})
      `;
      expect(rebound?.decision).toBe('rebound');
      expect(await sql`select decision from public.authorize_recommendation_scoped_admission(${rebound!.epoch}::bigint, ${to})`)
        .toEqual([{ decision: 'authorized' }]);
    });
  }

  async function report(versions = [1, 2], ready = true, reportedRevision = revision, reportedWorker = workerId) {
    await asSession('openspell_recommendation_worker', async (sql) => {
      await sql`select public.report_recommendation_runtime(${reportedWorker}, ${reportedRevision}, ${versions}::integer[], ${ready})`;
    });
  }

  async function readiness(expectedRevision = revision) {
    return asSession('service_role', async (sql) => sql<{ ready: boolean; reason: string | null }[]>`
      select ready, reason from public.get_one_time_recommendation_readiness(${expectedRevision})
    `);
  }

  function request() {
    return { orgId: scope.orgId, profileId: scope.profileId, actorId, clientRequestId: randomUUID(),
      scope: { mode: 'selected' as const, campaignIds: ['c-1'] }, oneTimeConfiguration: configuration, runAt };
  }

  async function counts() {
    const [row] = await database.sql<{ batches: number; runs: number; members: number; jobs: number }[]>`
      select
        (select count(*)::integer from public.recommendation_preview_batches where org_id = ${scope.orgId}::uuid) as batches,
        (select count(*)::integer from public.recommendation_runs where org_id = ${scope.orgId}::uuid) as runs,
        (select count(*)::integer from public.recommendation_run_campaigns where org_id = ${scope.orgId}::uuid) as members,
        (select count(*)::integer from public.sync_jobs where org_id = ${scope.orgId}::uuid and job_type = 'recommendations.run') as jobs
    `;
    if (row === undefined) throw new Error('missing artifact counts');
    return row;
  }

  async function refuseWithoutArtifacts(reason: string) {
    const before = await counts();
    await expect(store.enqueueRecommendationPreviewBatch(request()))
      .rejects.toThrow(`one-time recommendation unavailable: ${reason}`);
    expect(await counts()).toEqual(before);
  }

  async function queued(batchId: string) {
    const rows = await database.sql<{ id: string; job_id: string; group_id: string | null }[]>`
      select id, job_id, group_id from public.recommendation_runs where batch_id = ${batchId}::uuid
    `;
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  async function claim(claimRevision = revision, claimingWorker = workerId) {
    return asSession('openspell_recommendation_worker', async (sql) => sql<Claim[]>`
      select id, claim_token, attempts from public.claim_recommendation_jobs_fenced(${claimingWorker}, ${claimRevision}, 1)
    `);
  }

  it('refuses new v2 admission in legacy mode without leaving any artifacts', async () => {
    expect(await readiness()).toEqual([{ ready: false, reason: 'worker_not_activated' }]);
    await refuseWithoutArtifacts('worker_not_activated');
    await expect(report()).rejects.toThrow(/revision is not authorized/);
  });

  it('requires the actual worker session to publish readiness and admits exactly one child with a fresh compatible report', async () => {
    await activate();
    expect(await database.sql`
      select has_table_privilege('openspell_recommendation_executor', 'app.recommendation_claim_authority', 'SELECT') as readable,
             has_table_privilege('openspell_recommendation_executor', 'app.recommendation_claim_authority', 'UPDATE') as writable
    `).toEqual([{ readable: false, writable: false }]);
    for (const role of ['service_role', 'authenticated', 'anon']) {
      await asSession(role, async (sql) => {
        await expect(sql`select public.report_recommendation_runtime(${workerId}, ${revision}, array[1,2], true)`)
          .rejects.toThrow(/permission denied/);
        if (role !== 'service_role') {
          await expect(sql`select * from public.get_one_time_recommendation_readiness(${revision})`)
            .rejects.toThrow(/permission denied/);
        }
      });
    }
    expect(await database.sql`select * from app.recommendation_runtime_state`).toEqual([]);
    await report();
    expect(await readiness(oldRevision)).toEqual([{ ready: false, reason: 'revision_mismatch' }]);
    expect(await readiness()).toEqual([{ ready: true, reason: null }]);
    await expect(report([1, 2], true, oldRevision)).rejects.toThrow(/revision is not authorized/);
    const before = await counts();
    const accepted = await store.enqueueRecommendationPreviewBatch(request());
    expect(accepted).toMatchObject({ childCount: 1, scope: { campaignCount: 1 } });
    expect(await counts()).toEqual({ batches: before.batches + 1, runs: before.runs + 1,
      members: before.members + 1, jobs: before.jobs + 1 });
    const child = await queued(accepted.batchId);
    expect(await database.sql`select app.recommendation_job_scope_closes(${child.job_id}::uuid) as closes`)
      .toEqual([{ closes: true }]);
  });

  it('refuses unavailable, unready, expired, wrong-epoch, wrong-revision and unsupported runtimes without partial admission', async () => {
    await activate();
    expect(await readiness()).toEqual([{ ready: false, reason: 'worker_unavailable' }]);
    await refuseWithoutArtifacts('worker_unavailable');
    for (const state of ['unready', 'expired', 'epoch', 'revision', 'unsupported']) {
      await report(state === 'unsupported' ? [1] : [1, 2], state !== 'unready');
      if (state === 'expired') await database.sql`update app.recommendation_runtime_state set observed_at = clock_timestamp() - interval '61 seconds'`;
      if (state === 'epoch') await database.sql`update app.recommendation_runtime_state set authority_epoch = authority_epoch - 1`;
      if (state === 'revision') await database.sql`update app.recommendation_runtime_state set revision = ${oldRevision}`;
      const reason = state === 'unsupported' ? 'execution_unsupported' : 'worker_unavailable';
      expect(await readiness(), state).toEqual([{ ready: false, reason }]);
      await refuseWithoutArtifacts(reason);
    }
  });

  it('rechecks readiness at commit and rolls back the entire store admission if the report expires after insertion', async () => {
    await activate();
    await report();
    // This test-only trigger changes time evidence after the immediate gate accepted the INSERT.
    // The production deferred gate must reject the transaction, including its parent batch.
    await database.sql.unsafe(`
      create function public.expire_synthetic_runtime() returns trigger language plpgsql as $$
      begin
        update app.recommendation_runtime_state set observed_at = clock_timestamp() - interval '61 seconds';
        return new;
      end; $$;
      create trigger expire_synthetic_runtime after insert on public.sync_jobs
      for each row when (new.payload -> 'executionVersion' = '2'::jsonb)
      execute function public.expire_synthetic_runtime();
    `);
    await refuseWithoutArtifacts('worker_unavailable');
    // The synthetic expiration is transactional too: the pre-existing report survives rollback.
    expect(await readiness()).toEqual([{ ready: true, reason: null }]);
  });

  it('keeps v2 queued across an older worker rebind, allows v1 claims, and preserves custody after report expiry', async () => {
    const second = await seed('one-time-runtime-v1');
    await activate();
    await report();
    const accepted = await store.enqueueRecommendationPreviewBatch(request());
    const pending = await queued(accepted.batchId);
    const legacy = await store.enqueueRecommendationRun({ ...second, source: 'web', lookbackDays: 7, runAt });

    async function expectPending() {
      expect(await database.sql`select status::text, attempts, claim_token from public.sync_jobs where id = ${pending.job_id}::uuid`)
        .toEqual([{ status: 'queued', attempts: 0, claim_token: null }]);
    }

    await rebind(revision, oldRevision);
    const legacyClaims = await claim(oldRevision);
    expect(legacyClaims).toHaveLength(1);
    expect(legacyClaims[0]).toMatchObject({ id: legacy.jobId, attempts: 1 });
    await expectPending();
    await asSession('openspell_recommendation_worker', async (sql) => {
      const owned = legacyClaims[0]!;
      expect(await sql`select decision from public.fail_recommendation_run_fenced(
        ${owned.id}::uuid, ${workerId}, ${owned.claim_token}::uuid, ${oldRevision},
        ${second.orgId}::uuid, ${second.profileId}::uuid, ${legacy.runId}::uuid, ${second.groupId}::uuid,
        'synthetic runtime compatibility proof')`).toEqual([{ decision: 'failed' }]);
      expect(await sql`select decision, status from public.finish_recommendation_job_fenced(
        ${owned.id}::uuid, ${workerId}, ${owned.claim_token}::uuid, ${oldRevision}, 'dead',
        'synthetic runtime compatibility proof', '{}'::jsonb, null)`)
        .toEqual([{ decision: 'settled', status: 'dead' }]);
    });
    await report([1], true, oldRevision);
    expect(await claim(oldRevision)).toEqual([]);
    await expectPending();

    await rebind(oldRevision, revision);
    expect(await claim()).toEqual([]);
    await report([1, 2], true, revision, 'different-runtime-worker');
    expect(await claim()).toEqual([]);
    await expectPending();
    await report();
    const claims = await claim();
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ id: pending.job_id, attempts: 1 });
    const owned = claims[0]!;
    await database.sql`update app.recommendation_runtime_state set observed_at = clock_timestamp() - interval '61 seconds'`;
    expect(await readiness()).toEqual([{ ready: false, reason: 'worker_unavailable' }]);

    await asSession('openspell_recommendation_worker', async (sql) => {
      expect(await sql`select id, claim_token from public.resume_recommendation_jobs_fenced(${workerId}, ${revision})`)
        .toEqual([{ id: owned.id, claim_token: owned.claim_token }]);
      expect(await sql`select decision from public.start_recommendation_run_fenced(
        ${owned.id}::uuid, ${workerId}, ${owned.claim_token}::uuid, ${revision},
        ${scope.orgId}::uuid, ${scope.profileId}::uuid, ${pending.id}::uuid, ${pending.group_id}::uuid)`)
        .toEqual([{ decision: 'started' }]);
      const inputs = await sql<{ inputs: { targets: unknown[] }; group_safety: unknown }[]>`
        select inputs, group_safety from public.read_recommendation_inputs_fenced(
          ${owned.id}::uuid, ${workerId}, ${owned.claim_token}::uuid, ${revision},
          ${scope.orgId}::uuid, ${scope.profileId}::uuid, ${pending.id}::uuid, ${pending.group_id}::uuid,
          ${configuration.window.start}::date, ${configuration.window.end}::date)
      `;
      expect(inputs).toHaveLength(1);
      expect(inputs[0]?.inputs.targets).toHaveLength(1);
      expect(inputs[0]?.group_safety).toMatchObject({ mayPropose: true, exportedRecommendations: 0 });
      const completion = { lookbackDays: 26, window: configuration.window, strategySnapshot: null,
        proposals: [], narrative: { oneTimeConfiguration: configuration } };
      expect(await sql`select decision, proposals_count from public.succeed_recommendation_run_fenced(
        ${owned.id}::uuid, ${workerId}, ${owned.claim_token}::uuid, ${revision},
        ${scope.orgId}::uuid, ${scope.profileId}::uuid, ${pending.id}::uuid, ${pending.group_id}::uuid,
        ${JSON.stringify(completion)}::jsonb)`)
        .toEqual([{ decision: 'succeeded', proposals_count: 0 }]);
      expect(await sql`select decision, status from public.finish_recommendation_job_fenced(
        ${owned.id}::uuid, ${workerId}, ${owned.claim_token}::uuid, ${revision}, 'succeeded', null, '{}'::jsonb, null)`)
        .toEqual([{ decision: 'settled', status: 'succeeded' }]);
    });
    expect(await database.sql`
      select run.status::text, run.proposals_count, job.status::text as job_status, job.attempts, job.claim_token,
        (select count(*)::integer from public.recommendations where run_id = run.id) as persisted_proposals
      from public.recommendation_runs run join public.sync_jobs job on job.id = run.job_id where run.id = ${pending.id}::uuid
    `).toEqual([{ status: 'succeeded', proposals_count: 0, job_status: 'succeeded', attempts: 1,
      claim_token: null, persisted_proposals: 0 }]);
  });
});
