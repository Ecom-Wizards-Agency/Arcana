import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decideRecommendations, exportAcceptedRecommendations, getExportBatch } from '@wizard-ads/db';
import { asActor, asServiceRole, asUser, createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import type { OneTimeRpcConfiguration } from '@wizard-ads/shared';
import { PostgresRecommendationRunStore } from './recommendations-run.js';

const actorId = 'abababab-abab-4bab-8bab-abababababab';
const revision = 'b'.repeat(40);
const workerId = 'one-time-export-proof';
const refusal = 'One-time preview export awaits observation support.';
const configuration: OneTimeRpcConfiguration = {
  version: 1, method: 'rpc', targetAcos: 0.37,
  bidFloor: 0.11, bidCeiling: 4.3, bidIncreaseCap: 0.23, bidDecreaseCap: 0.41,
  window: { start: '2026-08-01', end: '2026-08-26' },
};
const available = await databaseAvailable();

describe.skipIf(!available)('one-time recommendations remain reviewable before observation support', () => {
  let database: TestDatabase;
  let orgId: string;
  let profileId: string;
  let runId: string;
  let recommendationId: string;

  beforeEach(async () => {
    database = await createTestDatabase('one_time_export');
    const [tenant] = await database.sql<{ org_id: string }[]>`
      select app.seed_tenant_fixture('one-time-export', ${actorId}::uuid, 'owner', date '2026-08-26') as org_id
    `;
    orgId = tenant!.org_id;
    const profiles = await database.sql<{ id: string }[]>`select id from public.ad_profiles where org_id = ${orgId}::uuid`;
    expect(profiles).toHaveLength(1);
    profileId = profiles[0]!.id;
    await database.sql`delete from public.campaign_optimization_assignments where org_id = ${orgId}::uuid`;
    await asServiceRole(database, async (sql) => {
      expect(await sql`select decision from public.block_recommendation_admission(0)`).toEqual([{ decision: 'blocked' }]);
      expect(await sql`select decision from public.activate_recommendation_fenced_claims(1, ${revision})`)
        .toEqual([{ decision: 'activated' }]);
      expect(await sql`select decision from public.authorize_recommendation_scoped_admission(2, ${revision})`)
        .toEqual([{ decision: 'authorized' }]);
    });
    const worker = await database.sql.reserve();
    try {
      await worker.unsafe('set session authorization openspell_recommendation_worker');
      expect(await worker`select session_user`).toEqual([{ session_user: 'openspell_recommendation_worker' }]);
      await worker`select public.report_recommendation_runtime(${workerId}, ${revision}, array[1,2], true)`;
      const accepted = await new PostgresRecommendationRunStore(database).enqueueRecommendationPreviewBatch({
        orgId, profileId, actorId, clientRequestId: randomUUID(),
        scope: { mode: 'selected', campaignIds: ['c-1'] }, oneTimeConfiguration: configuration,
        runAt: new Date('2026-09-01T12:00:00Z'),
      });
      expect(accepted).toMatchObject({ childCount: 1, scope: { campaignCount: 1 } });
      const runs = await database.sql<{ id: string; job_id: string; group_id: string | null; strategy_snapshot: unknown }[]>`
        select id, job_id, group_id, strategy_snapshot from public.recommendation_runs where batch_id = ${accepted.batchId}::uuid
      `;
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ group_id: null, strategy_snapshot: null });
      runId = runs[0]!.id;
      const claims = await worker<{ id: string; claim_token: string }[]>`
        select id, claim_token from public.claim_recommendation_jobs_fenced(${workerId}, ${revision}, 1)
      `;
      expect(claims).toHaveLength(1);
      const claim = claims[0]!;
      expect(claim.id).toBe(runs[0]!.job_id);
      expect(await worker`select decision from public.start_recommendation_run_fenced(
        ${claim.id}::uuid, ${workerId}, ${claim.claim_token}::uuid, ${revision},
        ${orgId}::uuid, ${profileId}::uuid, ${runId}::uuid, null)`)
        .toEqual([{ decision: 'started' }]);
      const completion = {
        lookbackDays: 26, window: configuration.window, strategySnapshot: null,
        narrative: { oneTimeConfiguration: configuration },
        proposals: [{
          reason: 'high_acos',
          entityRef: { entityType: 'keyword', entityId: 'kw-1', adProduct: 'SP', profileId,
            campaignId: 'c-1', adGroupId: 'ag-1', name: 'Synthetic keyword' },
          field: 'bid', currentValue: 0.9, proposedValue: 0.7,
          inputs: {}, preconditionNotes: [],
        }],
      };
      expect(await worker`select decision, proposals_count from public.succeed_recommendation_run_fenced(
        ${claim.id}::uuid, ${workerId}, ${claim.claim_token}::uuid, ${revision},
        ${orgId}::uuid, ${profileId}::uuid, ${runId}::uuid, null, ${JSON.stringify(completion)}::jsonb)`)
        .toEqual([{ decision: 'succeeded', proposals_count: completion.proposals.length }]);
      expect(await worker`select decision, status from public.finish_recommendation_job_fenced(
        ${claim.id}::uuid, ${workerId}, ${claim.claim_token}::uuid, ${revision}, 'succeeded', null, '{}'::jsonb, null)`)
        .toEqual([{ decision: 'settled', status: 'succeeded' }]);
    } finally {
      await worker.unsafe('reset session authorization');
      worker.release();
    }
    const proposals = await database.sql<{ id: string; status: string }[]>`
      select id, status::text from public.recommendations where run_id = ${runId}::uuid
    `;
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.status).toBe('proposed');
    recommendationId = proposals[0]!.id;
    await review('accepted');
  }, 60_000);
  afterEach(async () => { await database?.drop(); });

  async function review(decision: 'accepted' | 'dismissed') {
    // The web review boundary performs the audited write with its server credential.
    expect(await asServiceRole(database, async (sql) => decideRecommendations({ sql }, {
      orgId, ids: [recommendationId], actorId, decision, note: 'Synthetic review decision.',
    }))).toEqual({ updated: 1, refused: [] });
  }

  async function state() {
    return database.sql`
      select
        (select count(*)::integer from public.apply_batches where org_id = ${orgId}::uuid) as batches,
        (select count(*)::integer from public.apply_rows where org_id = ${orgId}::uuid) as rows,
        (select count(*)::integer from public.audit_log where org_id = ${orgId}::uuid) as audits,
        status::text, export_batch_id, decided_by, decided_at
      from public.recommendations where id = ${recommendationId}::uuid
    `;
  }

  async function emptyBatch() {
    const rows = await database.sql<{ id: string }[]>`
      insert into public.apply_batches (org_id, profile_id, tag, opt_group, lever, note)
      values (${orgId}::uuid, ${profileId}::uuid, ${randomUUID()}, 'synthetic', 'bid-down', 'Synthetic linkage proof.') returning id
    `;
    expect(rows).toHaveLength(1);
    return rows[0]!.id;
  }

  it('allows the normal audited review to dismiss and accept the actual one-time proposal', async () => {
    await review('dismissed');
    expect(await database.sql`select status::text, decided_by, export_batch_id from public.recommendations where id = ${recommendationId}::uuid`)
      .toEqual([{ status: 'dismissed', decided_by: actorId, export_batch_id: null }]);
    await review('accepted');
    expect(await database.sql`select status::text, decided_by, export_batch_id from public.recommendations where id = ${recommendationId}::uuid`)
      .toEqual([{ status: 'accepted', decided_by: actorId, export_batch_id: null }]);
  });

  it('refuses the transactional export with zero batch, row, audit or recommendation side effects', async () => {
    const before = await state();
    await expect(exportAcceptedRecommendations(database, {
      orgId, profileId, runId, ids: [recommendationId], tag: 'one-time-refused', optGroup: 'synthetic',
      lever: 'bid-down', note: 'Synthetic export attempt.', actorId,
    })).rejects.toThrow(refusal);
    expect(await state()).toEqual(before);
    expect(await database.sql`select count(*)::integer as count from public.apply_batches where org_id = ${orgId}::uuid and tag = 'one-time-refused'`)
      .toEqual([{ count: 0 }]);
  });

  it('refuses direct exported and applied status updates by an authenticated owner', async () => {
    const before = await state();
    await asUser(database, actorId, async (sql) => {
      for (const status of ['exported', 'applied']) {
        await expect(sql`update public.recommendations set status = ${status}::public.recommendation_status where id = ${recommendationId}::uuid`)
          .rejects.toMatchObject({ code: '23514', message: refusal });
      }
    });
    expect(await state()).toEqual(before);
  });

  it('refuses insertion or later attachment of a one-time recommendation to apply rows', async () => {
    const batchId = await emptyBatch();
    const beforeInsert = await state();
    await asServiceRole(database, async (sql) => {
      await expect(sql`insert into public.apply_rows
        (batch_id, org_id, profile_id, recommendation_id, entity_type, entity_id, field, old_value, new_value)
        values (${batchId}::uuid, ${orgId}::uuid, ${profileId}::uuid, ${recommendationId}::uuid,
          'keyword', 'kw-1', 'bid', '0.9'::jsonb, '0.7'::jsonb)`)
        .rejects.toMatchObject({ code: '23514', message: refusal });
    });
    expect(await state()).toEqual(beforeInsert);
    const unlinked = await database.sql<{ id: string }[]>`insert into public.apply_rows
      (batch_id, org_id, profile_id, entity_type, entity_id, field, old_value, new_value)
      values (${batchId}::uuid, ${orgId}::uuid, ${profileId}::uuid, 'keyword', 'kw-1', 'bid', '0.9'::jsonb, '0.8'::jsonb) returning id`;
    expect(unlinked).toHaveLength(1);
    const beforeUpdate = await state();
    await asServiceRole(database, async (sql) => {
      await expect(sql`update public.apply_rows set recommendation_id = ${recommendationId}::uuid where id = ${unlinked[0]!.id}::uuid`)
        .rejects.toMatchObject({ code: '23514', message: refusal });
    });
    expect(await state()).toEqual(beforeUpdate);
    expect(await database.sql`select recommendation_id from public.apply_rows where id = ${unlinked[0]!.id}::uuid`)
      .toEqual([{ recommendation_id: null }]);
  });

  it('refuses export-batch linkage that would otherwise expose an accepted proposal through workbook readback', async () => {
    const batchId = await emptyBatch();
    const before = await state();
    let error: unknown;
    try {
      await asUser(database, actorId, async (sql) => {
        await sql`update public.recommendations set export_batch_id = ${batchId}::uuid where id = ${recommendationId}::uuid`;
      });
    } catch (caught) {
      error = caught;
    }
    const artifact = await getExportBatch(database, { orgId, batchId });
    expect(artifact).not.toBeNull();
    expect(artifact?.proposals).toEqual([]);
    expect(error).toMatchObject({ code: '23514', message: refusal });
    expect(await state()).toEqual(before);
  });

  it('preserves one-time provenance when an authenticated owner tries to reparent the accepted proposal to a legacy run', async () => {
    const legacyRuns = await database.sql<{ id: string }[]>`
      select id from public.recommendation_runs where org_id = ${orgId}::uuid and profile_id = ${profileId}::uuid and scope_version = 1
    `;
    expect(legacyRuns).toHaveLength(1);
    await asUser(database, actorId, async (sql) => {
      await expect(sql`update public.recommendations set run_id = ${legacyRuns[0]!.id}::uuid where id = ${recommendationId}::uuid returning run_id`)
        .rejects.toThrow(/one-time|immutable|identity/i);
    });
    expect(await database.sql`select run_id, status::text from public.recommendations where id = ${recommendationId}::uuid`)
      .toEqual([{ run_id: runId, status: 'accepted' }]);
  });

  it('refuses moving a legacy recommendation with existing apply-row lineage into a one-time run', async () => {
    const legacy = await database.sql<{ id: string; run_id: string }[]>`
      select recommendation.id, recommendation.run_id from public.recommendations recommendation
      join public.recommendation_runs run on run.id = recommendation.run_id
      where recommendation.org_id = ${orgId}::uuid and run.scope_version = 1
    `;
    expect(legacy).toHaveLength(1);
    const batchId = await emptyBatch();
    const links = await database.sql<{ id: string }[]>`
      insert into public.apply_rows
        (batch_id, org_id, profile_id, recommendation_id, entity_type, entity_id, field, old_value, new_value)
      values (${batchId}::uuid, ${orgId}::uuid, ${profileId}::uuid, ${legacy[0]!.id}::uuid,
        'keyword', 'kw-1', 'bid', '0.9'::jsonb, '0.7'::jsonb) returning id
    `;
    expect(links).toHaveLength(1);
    await asUser(database, actorId, async (sql) => {
      await sql`update public.recommendations set status = 'exported', export_batch_id = ${batchId}::uuid where id = ${legacy[0]!.id}::uuid`;
      await expect(sql`update public.recommendations set run_id = ${runId}::uuid where id = ${legacy[0]!.id}::uuid`)
        .rejects.toThrow(/one-time|immutable|identity/i);
      // Clearing the row's export flags must not conceal the existing apply-row lineage.
      await sql`update public.recommendations set status = 'accepted', export_batch_id = null where id = ${legacy[0]!.id}::uuid`;
      await expect(sql`update public.recommendations set run_id = ${runId}::uuid where id = ${legacy[0]!.id}::uuid returning run_id`)
        .rejects.toThrow(/one-time|immutable|identity/i);
    });
    expect(await database.sql`
      select run.scope_version from public.apply_rows apply_row
      join public.recommendations recommendation on recommendation.id = apply_row.recommendation_id
      join public.recommendation_runs run on run.id = recommendation.run_id
      where apply_row.id = ${links[0]!.id}::uuid
    `).toEqual([{ scope_version: 1 }]);
  });

  it('refuses browser and service attempts to duplicate the completed proposal under legacy lineage', async () => {
    const [legacy] = await database.sql<{ id: string }[]>`
      select id from public.recommendation_runs where org_id = ${orgId}::uuid and scope_version = 1
    `;
    const before = await database.sql`select id, run_id from public.recommendations where org_id = ${orgId}::uuid order by id`;
    for (const role of ['authenticated', 'service_role'] as const) {
      await asActor(database, { role, userId: actorId }, async (sql) => {
        await expect(sql`insert into public.recommendations
          (run_id, org_id, profile_id, reason, entity_type, entity_id, ad_product, campaign_id,
           ad_group_id, entity_name, field, current_value, proposed_value, inputs, status)
          select ${legacy!.id}::uuid, org_id, profile_id, reason, entity_type, entity_id, ad_product, campaign_id,
            ad_group_id, entity_name, field, current_value, proposed_value, inputs, 'accepted'
          from public.recommendations where id = ${recommendationId}::uuid`)
          .rejects.toMatchObject({ code: '42501' });
      });
    }
    expect(await database.sql`select id, run_id from public.recommendations where org_id = ${orgId}::uuid order by id`).toEqual(before);
  });
});
