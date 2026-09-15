import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OneTimeRpcSnapshot, type OptimizerSelectionExportRequest } from '@wizard-ads/shared';
import { spWriteConfirmation } from '@wizard-ads/shared/sp-write-application';
import { createTestDatabase, type TestDatabase } from '../testing/harness.js';
import { syntheticRecommendationMethodInputs } from '../testing/recommendation-method.js';
import { withAuthenticatedOrgEditor, withAuthenticatedReadSnapshot } from './authenticated-actor.js';
import { exportOptimizerSelection, readOptimizerExportBinding } from './optimizer-export.js';
import { readOptimizationWorkspace } from './optimization-groups.js';
import { previewSpWriteForActor, approveSpWriteForActor, readRecordedSpWritePreviewForActor } from './sp-write-commands.js';

const snapshot = OneTimeRpcSnapshot.parse({ version: 1,
  configuration: { version: 1, method: 'sp.reference-efficiency', targetAcos: 0.27, bidFloor: 0.13, bidCeiling: 3.1,
    bidIncreaseCap: 0.17, bidDecreaseCap: 0.31, window: { start: '2026-08-01', end: '2026-08-28' } },
  profileTimezone: 'UTC', admittedAt: '2026-09-10T12:00:00Z', profileToday: '2026-09-10' });

describe('one-time complete selection export authority', () => {
  let db: TestDatabase;
  const actors: { orgId: string; userId: string }[] = [];
  beforeAll(async () => {
    db = await createTestDatabase('optimizer_export');
    for (let i = 0; i < 4; i += 1) {
      const userId = randomUUID();
      const [org] = await db.sql<{ id: string }[]>`select app.seed_tenant_fixture(${randomUUID()},${userId},'owner') as id`;
      actors.push({ orgId: org!.id, userId });
    }
    // Fixture-only definer seeds recorded worker output under its real session guard.
    await db.sql`create function public.synthetic_optimizer_output(p_row jsonb) returns void
      language sql security definer set search_path=pg_catalog,public as $$
      insert into public.recommendations(id,run_id,org_id,profile_id,reason,entity_type,entity_id,entity_name,
        campaign_id,ad_group_id,ad_product,field,current_value,proposed_value,inputs,status)
      select id,run_id,org_id,profile_id,reason,entity_type,entity_id,entity_name,campaign_id,ad_group_id,ad_product,
        field,current_value,proposed_value,inputs,status from jsonb_populate_record(null::public.recommendations,p_row)
      $$`;
    const session = await db.sql.reserve();
    try {
      await session`set session authorization service_role`;
      await session`select public.block_recommendation_admission(0)`;
      await session`select public.activate_recommendation_fenced_claims(1,${'c'.repeat(40)})`;
      await session`select public.authorize_recommendation_scoped_admission(2,${'c'.repeat(40)})`;
    } finally { await session`reset session authorization`; session.release(); }
  }, 60_000);
  afterAll(async () => { await db?.drop(); });
  async function fixture(incomplete = false) {
    const actor = actors.shift()!; const { orgId, userId } = actor;
    const session = await db.sql.reserve();
    try {
      await session`set session authorization openspell_recommendation_worker`;
      await session`select public.report_recommendation_runtime('synthetic-export-fixture',${'c'.repeat(40)},array[1,2],true)`;
    } finally { await session`reset session authorization`; session.release(); }
    const [profile] = await db.sql<{ id: string }[]>`select id from public.ad_profiles where org_id=${orgId}::uuid`;
    const profileId = profile!.id;
    const group = (await readOptimizationWorkspace(db, { orgId, profileId })).groups[0]!.group;
    const batchId = randomUUID(); const runs = [randomUUID(), randomUUID()];
    const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await db.sql`insert into public.campaigns(org_id,profile_id,amazon_id,ad_product,name,state,budget_amount,budget_type)
      values(${orgId},${profileId},'synthetic-second','SP','Synthetic second campaign','enabled',17,'daily')`;
    await db.sql.begin(async (sql) => {
    await sql`insert into public.recommendation_preview_batches(id,org_id,profile_id,client_request_id,selection_mode,
      request_fingerprint,scope_count,scope_fingerprint,child_count,created_by,execution_snapshot)
      values(${batchId},${orgId},${profileId},${randomUUID()},'selected',${'a'.repeat(64)},2,
        app.recommendation_batch_scope_fingerprint(${profileId},array['c-1','synthetic-second']),2,${userId},${JSON.stringify(snapshot)}::jsonb)`;
    for (const [index, runId] of runs.entries()) {
      const job = randomUUID(); const campaign = index === 0 ? 'c-1' : 'synthetic-second';
      await sql`insert into public.sync_jobs(id,org_id,profile_id,job_type,payload,status,started_at,finished_at)
        values(${job},${orgId},${profileId},'recommendations.run',jsonb_build_object('type','recommendations.run','orgId',${orgId}::text,'profileId',${profileId}::text,'runId',${runId}::text,'groupId',${index === 0 ? group.id : null}::text,'executionVersion',2,'snapshotFingerprint', app.one_time_rpc_snapshot_fingerprint(${JSON.stringify(snapshot)}::jsonb)),'succeeded',now(),now())`;
      await sql`insert into public.recommendation_runs(id,org_id,profile_id,batch_id,status,lookback_days,scope_version,
        scope_count,scope_fingerprint,job_id,execution_snapshot,execution_lineage,proposals_count,group_id,group_role,group_snapshot)
        values(${runId},${orgId},${profileId},${batchId},'succeeded',28,2,1,
          app.recommendation_run_scope_fingerprint(${profileId},${index === 0 ? group.id : null}::uuid,array[${campaign}]),${job},
          ${JSON.stringify(snapshot)}::jsonb,'queue',${incomplete && index === 0 ? 3 : 2},${index === 0 ? group.id : null}::uuid,${index === 0 ? group.role : null},
          ${index === 0 ? JSON.stringify(group) : null}::jsonb)`;
      await sql`insert into public.recommendation_run_campaigns(org_id,profile_id,batch_id,run_id,campaign_id)
        values(${orgId},${profileId},${batchId},${runId},${campaign})`;
      for (const offset of [0, 1]) {
        const i = index * 2 + offset; const keyword = `synthetic-export-${i}`;
        await sql`insert into public.keywords(org_id,profile_id,amazon_id,ad_product,name,state,campaign_id,ad_group_id,keyword_text,match_type,bid)
          values(${orgId},${profileId},${keyword},'SP',${`Synthetic selected target ${i}`},'enabled',${campaign},'ag-1','synthetic','exact',0.91)`;
        await sql`set local session authorization openspell_recommendation_worker`;
        await sql`select public.synthetic_optimizer_output(${JSON.stringify({ id: ids[i], run_id: runId, org_id: orgId,
          profile_id: profileId, reason: 'high_acos', entity_type: 'keyword', entity_id: keyword,
          entity_name: `Synthetic selected target ${i}`, campaign_id: campaign, ad_group_id: 'ag-1', ad_product: 'SP',
          field: 'bid', current_value: 0.91, proposed_value: 0.67, inputs: syntheticRecommendationMethodInputs(),
          status: offset === 0 ? 'accepted' : index === 0 ? 'proposed' : 'dismissed' })}::jsonb)`;
        await sql`reset session authorization`;
      }
    }
    });
    const version = randomUUID();
    await db.sql`insert into public.sp_write_profile_grant_versions(grant_id,version_id,org_id,profile_id,enabled,amazon_profile_id,connection_id,region,marketplace_id,currency_code,api_dialect,created_by)
      select grant_id,${version},org_id,profile_id,true,amazon_profile_id,connection_id,region,marketplace_id,currency_code,api_dialect,created_by
      from public.sp_write_profile_grant_versions where org_id=${orgId} and profile_id=${profileId}`;
    await db.sql`update public.sp_write_profile_grant_heads set version_id=${version} where org_id=${orgId} and profile_id=${profileId}`;
    const reviewFingerprint = await withAuthenticatedReadSnapshot(db, actor, (tx) => readOptimizerExportBinding(tx, { orgId, profileId, batchId }));
    expect(reviewFingerprint).toMatch(/^[a-f0-9]{64}$/);
    const request: OptimizerSelectionExportRequest = { requestId: randomUUID(), profileId, batchId, reviewFingerprint: reviewFingerprint!, recommendationIds: [ids[0]!, ids[2]!].sort() };
    return { actor, profileId, batchId, runs, ids, request };
  }
  async function count(orgId: string) {
    return (await db.sql`select (select count(*)::int from app.optimizer_selection_exports where org_id=${orgId}) as exports,
      (select count(*)::int from app.sp_write_forward_lineage where org_id=${orgId}) as retries,
      (select count(*)::int from public.sp_write_outbox o join public.sp_write_plans p using(org_id,profile_id,plan_id) where o.org_id=${orgId} and p.artifact ? 'schemaVersion') as outbox`)[0];
  }
  it('exports the complete accepted selection across two children into one exact forward source', async () => {
    const f = await fixture();
    const result = await withAuthenticatedOrgEditor(db, f.actor, (tx) => exportOptimizerSelection(tx, f.request));
    expect(result.counts).toEqual({ offered: 2, accepted: 2, exported: 2, applyRows: 2 });
    const rows = await db.sql<{ id: string; status: string; export_batch_id: string | null }[]>`select id,status,export_batch_id from public.recommendations where id=any(${f.ids}::uuid[])`;
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.status === 'exported').map((r) => r.id).sort()).toEqual(f.request.recommendationIds);
    expect(rows.find((r) => r.id === f.ids[1])).toMatchObject({ status: 'proposed', export_batch_id: null });
    expect(rows.find((r) => r.id === f.ids[3])).toMatchObject({ status: 'dismissed', export_batch_id: null });
    const request = { requestId: randomUUID(), profileId: f.profileId, applyBatchId: result.applyBatchId, forwardRowIds: result.forwardRowIds };
    const preview = await withAuthenticatedOrgEditor(db, f.actor, (tx) => previewSpWriteForActor(tx, request));
    expect(preview.plan.counts.logicalChanges).toBe(2);
    expect(preview.plan.actions.flatMap((a) => a.sources.map((s) => s.kind === 'apply_row' ? s.applyRowId : '')).sort()).toEqual(result.forwardRowIds);
    expect(preview.evidence?.guardrails).toMatchObject({ policies: expect.arrayContaining([expect.objectContaining({ strategyGoal: 'one_time' })]) });
    expect(await count(f.actor.orgId)).toEqual({ exports: 1, retries: 0, outbox: 0 });
    const recorded = await withAuthenticatedReadSnapshot(db, f.actor, (tx) => readRecordedSpWritePreviewForActor(tx, { profileId: f.profileId, planId: preview.plan.id }));
    expect(recorded.preview).toEqual(preview);
    expect(recorded.freshness.reasons).toEqual(['gate_disabled']);
    // Enable authority only inside this disposable test database. No worker is run.
    const gate = randomUUID();
    await db.sql`insert into public.sp_write_environment_gate_versions(version_id,enabled,max_unresolved_calls) values(${gate},true,1)`;
    await db.sql`insert into public.sp_write_environment_gate_head(singleton,version_id) values(true,${gate})`;
    try {
      const confirmation = { profileId: f.profileId, confirmation: spWriteConfirmation(preview.plan.counts.logicalChanges),
        approval: { approvalRequestId: randomUUID(), plan: preview.binding, approvalMode: 'manual' as const,
          confirmationVersion: 'openspell.amazon-sp-write-confirmation.v1' as const, boundedAuthorization: null, preapprovedInversePlan: null } };
      const admission = await withAuthenticatedOrgEditor(db,f.actor,(tx) => approveSpWriteForActor(tx,confirmation));
      expect(await withAuthenticatedOrgEditor(db,f.actor,(tx) => approveSpWriteForActor(tx,confirmation))).toEqual(admission);
      const claims = await db.sql<{ source_row_id: string }[]>`select source_row_id from app.sp_write_forward_admissions where org_id=${f.actor.orgId}`;
      expect(claims.map((claim) => claim.source_row_id).sort()).toEqual(result.forwardRowIds);
      expect(await count(f.actor.orgId)).toEqual({ exports: 1, retries: 0, outbox: 1 });
      expect((await db.sql`select count(*)::int as count from public.sp_write_provider_call_intents where org_id=${f.actor.orgId} and plan_id=${preview.plan.id}`)[0]).toEqual({count:0});
    } finally { await db.sql`delete from public.sp_write_environment_gate_head where singleton`; }
  });
  it('recovers lost export and preview responses with the same persisted identities', async () => {
    const f = await fixture(); const execute = () => withAuthenticatedOrgEditor(db, f.actor, (tx) => exportOptimizerSelection(tx, f.request));
    const saved = await execute();
    await expect(execute().then(() => { throw new Error('synthetic lost response'); })).rejects.toThrow('lost response');
    expect(await execute()).toEqual(saved);
    const req = { requestId: randomUUID(), profileId: f.profileId, applyBatchId: saved.applyBatchId, forwardRowIds: saved.forwardRowIds };
    const preview = await withAuthenticatedOrgEditor(db, f.actor, (tx) => previewSpWriteForActor(tx, req));
    expect(await withAuthenticatedOrgEditor(db, f.actor, (tx) => previewSpWriteForActor(tx, req))).toEqual(preview);
    expect(await count(f.actor.orgId)).toEqual({ exports: 1, retries: 0, outbox: 0 });
    await expect(withAuthenticatedOrgEditor(db, f.actor, (tx) => exportOptimizerSelection(tx, { ...f.request, recommendationIds: [f.request.recommendationIds[0]!] }))).rejects.toThrow('identity conflict');
    await expect(withAuthenticatedOrgEditor(db, f.actor, (tx) => previewSpWriteForActor(tx, { ...req, forwardRowIds: [saved.forwardRowIds[0]!] }))).rejects.toMatchObject({ code: 'identity_conflict' });
    await expect(db.sql`delete from app.optimizer_selection_exports where org_id=${f.actor.orgId}`).rejects.toThrow('immutable');
    await db.sql`delete from public.orgs where id=${f.actor.orgId}`;
    expect(await count(f.actor.orgId)).toEqual({ exports: 0, retries: 0, outbox: 0 });
  });
  it('refuses partial accepted membership, changed recorded inputs and stale mirror values atomically', async () => {
    const f = await fixture();
    await expect(withAuthenticatedOrgEditor(db, f.actor, (tx) => exportOptimizerSelection(tx, { ...f.request, recommendationIds: [f.request.recommendationIds[0]!] }))).rejects.toThrow('complete accepted');
    await db.sql`update public.recommendations set proposed_value='0.66'::jsonb where id=${f.ids[0]!}`;
    await expect(withAuthenticatedOrgEditor(db, f.actor, (tx) => exportOptimizerSelection(tx, f.request))).rejects.toThrow('Review inputs changed');
    await db.sql`update public.recommendations set proposed_value='0.67'::jsonb where id=${f.ids[0]!}`;
    await db.sql`update public.keywords set bid=0.92 where org_id=${f.actor.orgId} and amazon_id='synthetic-export-0'`;
    await expect(withAuthenticatedOrgEditor(db, f.actor, (tx) => exportOptimizerSelection(tx, f.request))).rejects.toThrow('Current values changed');
    expect(await count(f.actor.orgId)).toEqual({ exports: 0, retries: 0, outbox: 0 });
  });
  it('refuses an incomplete child scope and direct receipt or export forgery', async () => {
    const f = await fixture(true);
    await expect(db.sql`update public.recommendations set status='exported' where id=${f.ids[0]!}`).rejects.toMatchObject({ code: '23514', detail: expect.stringContaining('selection') });
    await expect(withAuthenticatedOrgEditor(db, f.actor, (tx) => tx.sql`insert into app.optimizer_selection_exports(org_id) values(${f.actor.orgId})`)).rejects.toMatchObject({ code: '42501' });
    await expect(withAuthenticatedOrgEditor(db, f.actor, (tx) => exportOptimizerSelection(tx, f.request))).rejects.toThrow('scope does not reconcile');
    expect(await count(f.actor.orgId)).toEqual({ exports: 0, retries: 0, outbox: 0 });
  });
});
