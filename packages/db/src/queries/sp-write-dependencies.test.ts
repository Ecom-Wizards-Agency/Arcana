import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CoordinatedMethodInput, DependencySet } from '@wizard-ads/shared';
import { SpWriteAction, SpWritePredispatchObservation, SpWriteProviderCallIntent, SpWriteProviderResult, SpWriteObservation,
  observedActionForSide, serializeSpWritePredispatchObservationFingerprint, serializeSpWriteProviderRequestFingerprint,
  serializeSpWriteProviderCallIntentFingerprint, serializeSpWriteProviderResultFingerprint, serializeSpWriteObservationFingerprint,
  serializeSpWriteActionFingerprint, serializeSpWritePlanFingerprint, type SpWritePlan } from '@wizard-ads/shared/sp-writes';
import { SpWriteDependencyPreviewEvidence, serializeSpWritePreviewGuardrails, serializeSpWritePreviewProvenance } from '@wizard-ads/shared/sp-write-preview-evidence';
import { createTestDatabase, type TestDatabase } from '../testing/harness.js';
import { syntheticRecommendationMethodInputs } from '../testing/recommendation-method.js';
import { exportAcceptedRecommendations } from './recommendations.js';
import { withAuthenticatedOrgEditor } from './authenticated-actor.js';
import { approveSpWriteForActor, previewSpWriteForActor } from './sp-write-commands.js';
import { buildSpWriteLegacyPreview } from './sp-write-plan-builder.js';
import { createSpWriteOutboxLedger, createSpWriteRuntimeLedger, settleSpWriteDependencies } from './sp-write-persistence.js';
import { reconcileSpWriteObservation } from './sp-write-mirror.js';

const USER = '31313131-3131-4131-8131-313131313131';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

describe('dependency source authority in PostgreSQL', () => {
  let db: TestDatabase;
  let orgId: string;
  let profileId: string;
  beforeEach(async () => {
    db = await createTestDatabase('dependency_source');
    const [tenant] = await db.sql<{ id: string }[]>`select app.seed_tenant_fixture('dependency-source',${USER},'owner') as id`;
    orgId = tenant!.id;
    const [profile] = await db.sql<{ id: string }[]>`select id from public.ad_profiles where org_id=${orgId}`;
    profileId = profile!.id;
    const version = randomUUID();
    await db.sql`insert into public.sp_write_profile_grant_versions
      (grant_id,version_id,org_id,profile_id,enabled,amazon_profile_id,connection_id,region,marketplace_id,currency_code,api_dialect,created_by)
      select grant_id,${version},org_id,profile_id,true,amazon_profile_id,connection_id,region,marketplace_id,currency_code,api_dialect,created_by
      from public.sp_write_profile_grant_versions where org_id=${orgId} and profile_id=${profileId}`;
    await db.sql`update public.sp_write_profile_grant_heads set version_id=${version} where org_id=${orgId} and profile_id=${profileId}`;
    const gate = randomUUID();
    await db.sql`insert into public.sp_write_environment_gate_versions(version_id,enabled,max_unresolved_calls) values(${gate},true,1)`;
    await db.sql`insert into public.sp_write_environment_gate_head(singleton,version_id) values(true,${gate})`;
    await db.sql`update public.targets set state='archived' where org_id=${orgId} and profile_id=${profileId}`;
    await db.sql`update public.keywords set bid=0.6 where org_id=${orgId} and profile_id=${profileId} and amazon_id='kw-1'`;
    await db.sql`update public.campaigns set bidding_strategy='manual',placement_bidding='{"topOfSearch":100,"restOfSearch":0,"productPages":0}'::jsonb
      where org_id=${orgId} and profile_id=${profileId} and amazon_id='c-1'`;
  }, 60_000);
  afterEach(async () => { await db?.drop(); });

  async function source(options: { bidOnly?: boolean; extraBid?: boolean } = {}) {
    const runId = randomUUID();
    const entity = { profileId, campaignId: 'c-1', adProduct: 'SP' as const, entityType: 'campaign' as const, entityId: 'c-1' };
    const dependency = DependencySet.parse({ id: `${runId}:c-1`, campaignId: 'c-1', changes: [
      { control: 'target_bid', entityRef: { ...entity, entityType: 'keyword', entityId: 'kw-1' }, current: 0.6, proposed: 0.3, unit: 'currency_per_click' },
      { control: 'placement_adjustment', entityRef: entity, placementKey: 'top_of_search', current: 100, proposed: 300, unit: 'percentage' },
      { control: 'placement_adjustment', entityRef: entity, placementKey: 'rest_of_search', current: 0, proposed: 100, unit: 'percentage' },
    ], precedenceReasons: ['Observe the base reduction.', 'Observe the first placement.'] });
    const snapshot = CoordinatedMethodInput.parse({ runId, profileId, methodId: 'sp.coordinated-efficiency', methodVersion: 'candidate.1',
      window: { start: '2026-08-01', end: '2026-08-28' }, admittedAt: '2026-09-10T00:00:00Z',
      methodParameters: { targetAcos: 0.3, caps: { maxIncrease: 0.5, maxDecrease: 0.6 }, floors: { manualMinBid: 0.1 },
        ceilings: { manualMaxBid: 1 }, exposureCeiling: 1.5, minClicksPerPlacement: 20, placementEvidenceRequirements: 'single_target' },
      resolvedSettings: syntheticRecommendationMethodInputs().settingSources,
      evidenceRows: [{ entityRef: { ...entity, entityType: 'keyword', entityId: 'kw-1' }, adProduct: 'SP', currentBid: 0.6,
        metrics: { clicks: 100, sales: 260, orders: 10, cost: 90 }, levels: { profile: { clicks: 100, sales: 260, orders: 10 } }, stock: { status: 'in_stock', asins: [] } }],
      campaignEvidence: { campaignId: 'c-1', costType: 'cpc', complete: true, targetCount: 1, attributionMature: true,
        homogeneousProxyValidation: null, currentControls: { strategy: 'manual', placements: { topOfSearch: 100, restOfSearch: 0, productPages: 0, amazonBusiness: null },
          shopperCohorts: [], offAmazonBudgetControlStrategy: null }, placementFacts: [],
        capabilities: { version: 'synthetic', entries: [{ adProduct: 'SP', costType: 'cpc', control: 'target_bid', available: true,
          unit: 'currency_per_click', range: { min: 0, max: null }, precision: 'decimal', decimalPlaces: 2,
          overlapRule: 'not_applicable', apiVersion: 'synthetic', verifiedOn: '2026-08-01' }] } } });
    if (options.bidOnly) {
      dependency.changes = [dependency.changes[0]!];
      dependency.changes[0]!.current = 0.2;
      dependency.precedenceReasons = [];
      snapshot.evidenceRows[0]!.currentBid = 0.2;
      snapshot.campaignEvidence.currentControls!.placements.topOfSearch = 300;
      await db.sql`update public.keywords set bid=0.2 where org_id=${orgId} and profile_id=${profileId} and amazon_id='kw-1'`;
    }
    if (options.extraBid) {
      const row = structuredClone(snapshot.evidenceRows[0]!);
      row.entityRef.entityId = 'kw-support'; row.currentBid = 0.3;
      snapshot.evidenceRows.push(row); snapshot.campaignEvidence.targetCount = 2;
      snapshot.campaignEvidence.homogeneousProxyValidation = 'Synthetic complete target coverage';
      snapshot.methodParameters.placementEvidenceRequirements = 'validated_homogeneous';
      await db.sql`insert into public.keywords(org_id,profile_id,amazon_id,ad_product,name,state,campaign_id,ad_group_id,keyword_text,match_type,bid,synced_at)
        select org_id,profile_id,'kw-support',ad_product,'Synthetic supporting bid',state,campaign_id,ad_group_id,'synthetic support',match_type,0.3,synced_at
        from public.keywords where org_id=${orgId} and profile_id=${profileId} and amazon_id='kw-1'`;
    }
    await db.sql.begin(async (sql) => {
      const [time] = await sql<{ now: string }[]>`select app.sp_write_instant(clock_timestamp()) as now`;
      const controls = snapshot.campaignEvidence.currentControls!;
      await sql`select set_config('app.campaign_control_read_started_at',${time!.now},true)`;
      await sql`update public.campaigns set bidding_control_state=${JSON.stringify(controls)}::jsonb,
        bidding_observed_at=${time!.now}::timestamptz,bidding_strategy=${controls.strategy}::public.bidding_strategy,
        placement_bidding=${JSON.stringify({ topOfSearch: controls.placements.topOfSearch, restOfSearch: controls.placements.restOfSearch, productPages: controls.placements.productPages })}::jsonb
        where org_id=${orgId} and profile_id=${profileId} and amazon_id='c-1'`;
    });
    const jobId = randomUUID();
    await db.sql.begin(async (sql) => {
      await sql`insert into public.sync_jobs(id,org_id,profile_id,job_type,payload,status,started_at,finished_at)
        values(${jobId},${orgId},${profileId},'recommendations.run',
          ${JSON.stringify({ type: 'recommendations.run', orgId, profileId, runId, lookbackDays: 28 })}::text::jsonb,
          'succeeded',clock_timestamp(),clock_timestamp())`;
      await sql`insert into public.recommendation_runs(id,org_id,profile_id,status,lookback_days,method_id,method_version,
        strategy_snapshot,strategy_goal,scope_version,scope_count,scope_fingerprint,job_id,execution_lineage)
        select ${runId},org_id,profile_id,'succeeded',28,'sp.coordinated-efficiency','candidate.1',strategy_snapshot,strategy_goal,
          1,1,app.recommendation_run_scope_fingerprint(${profileId}::uuid,null,array['c-1']),${jobId},'queue'
        from public.recommendation_runs where org_id=${orgId} and profile_id=${profileId} limit 1`;
      await sql`insert into public.recommendation_run_campaigns(org_id,profile_id,run_id,campaign_id) values(${orgId},${profileId},${runId},'c-1')`;
    });
    await db.sql`insert into public.audit_log(org_id,actor_type,action,target_type,target_id,payload,source)
      values(${orgId},'service','recommendation.run.succeeded','recommendation_run',${runId},
        ${JSON.stringify({ narrative: { calculationSnapshots: [snapshot] } })}::text::jsonb,'worker')`;
    const recommendationId = randomUUID();
    await db.sql`insert into public.recommendations
      (id,run_id,org_id,profile_id,reason,entity_type,entity_id,ad_product,campaign_id,field,current_value,proposed_value,inputs,status)
      values(${recommendationId},${runId},${orgId},${profileId},'high_acos','campaign','c-1','SP','c-1','control_set',null,null,
        ${JSON.stringify({ ...syntheticRecommendationMethodInputs(0.3), methodId: snapshot.methodId, methodVersion: snapshot.methodVersion,
          settingSources: snapshot.resolvedSettings, dependencySet: dependency })}::text::jsonb,'accepted')`;
    const batch = await withAuthenticatedOrgEditor(db, { orgId, userId: USER }, (context) => exportAcceptedRecommendations(context,
      { orgId, profileId, runId, ids: [recommendationId], tag: randomUUID(), optGroup: 'synthetic', lever: 'other', note: 'Synthetic source binding', actorId: USER }));
    return { requestId: randomUUID(), profileId, applyBatchId: batch.batchId };
  }

  function rehash(plan: SpWritePlan, evidence: SpWriteDependencyPreviewEvidence) {
    plan.actions = plan.actions.map((action) => SpWriteAction.parse({ ...action, fingerprint: hash(serializeSpWriteActionFingerprint(action)) }));
    if (plan.source.kind !== 'apply_batch') throw new Error('fixture');
    plan.source.guardrailSnapshotFingerprint = hash(serializeSpWritePreviewGuardrails(evidence));
    plan.source.provenanceSnapshotFingerprint = hash(serializeSpWritePreviewProvenance(evidence));
    plan.fingerprint = hash(serializeSpWritePlanFingerprint(plan));
  }

  async function record(plan: SpWritePlan, evidence: SpWriteDependencyPreviewEvidence) {
    return withAuthenticatedOrgEditor(db, { orgId, userId: USER }, (context) => context.sql`
      select app.record_sp_write_preview_for_actor(${orgId}::uuid,${USER}::uuid,
        ${JSON.stringify(plan)},${serializeSpWritePlanFingerprint(plan)},
        ${JSON.stringify(plan.actions.map((action) => ({ artifactText: JSON.stringify(action), fingerprintPreimage: serializeSpWriteActionFingerprint(action) })))}::text::jsonb,
        ${JSON.stringify(evidence)},${serializeSpWritePreviewGuardrails(evidence)},${serializeSpWritePreviewProvenance(evidence)})`);
  }

  async function changeExposure(kind: 'TOS' | 'mode' | 'audience' | 'business' | 'supporting bid' | 'target inventory') {
    if (kind === 'supporting bid') {
      await db.sql`update public.keywords set bid=0.4 where org_id=${orgId} and profile_id=${profileId} and amazon_id='kw-support'`;
      return;
    }
    if (kind === 'target inventory') {
      await db.sql`insert into public.keywords(org_id,profile_id,amazon_id,ad_product,name,state,campaign_id,ad_group_id,keyword_text,match_type,bid,synced_at)
        select org_id,profile_id,'kw-added',ad_product,'Synthetic added target',state,campaign_id,ad_group_id,'synthetic added',match_type,0.4,synced_at
        from public.keywords where org_id=${orgId} and profile_id=${profileId} and amazon_id='kw-1'`;
      return;
    }
    await db.sql.begin(async (sql) => {
      const [row] = await sql<{ controls: CoordinatedMethodInput['campaignEvidence']['currentControls']; now: string }[]>`
        select bidding_control_state as controls,app.sp_write_instant(clock_timestamp()) as now from public.campaigns
        where org_id=${orgId} and profile_id=${profileId} and amazon_id='c-1'`;
      const controls = row!.controls!;
      if (kind === 'TOS') controls.placements.topOfSearch = 900;
      if (kind === 'mode') controls.strategy = 'auto_for_sales';
      if (kind === 'audience') controls.shopperCohorts = [{ shopperCohortType: 'PURCH', percentage: 50, audienceSegments: [] }];
      if (kind === 'business') controls.placements.amazonBusiness = 100;
      await sql`select set_config('app.campaign_control_read_started_at',${row!.now},true)`;
      await sql`update public.campaigns set bidding_control_state=${JSON.stringify(controls)}::jsonb,
        bidding_observed_at=${row!.now}::timestamptz,bidding_strategy=${controls.strategy}::public.bidding_strategy,
        placement_bidding=${JSON.stringify({ topOfSearch: controls.placements.topOfSearch, restOfSearch: controls.placements.restOfSearch, productPages: controls.placements.productPages })}::jsonb
        where org_id=${orgId} and profile_id=${profileId} and amazon_id='c-1'`;
    });
  }

  it.each((['preview', 'approval', 'dispatch'] as const).flatMap((phase) =>
    (['TOS', 'mode', 'audience', 'business', 'supporting bid', 'target inventory'] as const).map((control) => ({ phase, control }))))(
    'refuses changed unchanged $control at $phase for a bid-only set', async ({ phase, control }) => {
      const request = await source({ bidOnly: true, extraBid: control === 'supporting bid' });
      await db.sql`update app.sp_write_method_releases set release_state='pilot' where method_id='sp.coordinated-efficiency'`;
      const build = () => withAuthenticatedOrgEditor(db, { orgId, userId: USER }, (context) => previewSpWriteForActor(context, request));
      if (phase === 'preview') {
        await changeExposure(control);
        await expect(build()).rejects.toMatchObject({ code: 'source_changed' });
      } else {
        const preview = await build();
        expect(preview.plan.actions).toHaveLength(1);
        expect(preview.evidence?.schemaVersion).toBe('openspell.sp-write-preview-evidence.v3');
        const approve = () => withAuthenticatedOrgEditor(db, { orgId, userId: USER }, (context) => approveSpWriteForActor(context, {
          profileId, confirmation: 'Yes, apply 1 changes to Amazon', approval: { approvalRequestId: randomUUID(), plan: preview.binding,
            approvalMode: 'manual', confirmationVersion: 'openspell.amazon-sp-write-confirmation.v1', boundedAuthorization: null, preapprovedInversePlan: null },
        }));
        if (phase === 'approval') {
          await changeExposure(control);
          await expect(approve()).rejects.toMatchObject({ code: '55000', message: expect.stringContaining('source_changed') });
          expect(await db.sql`select count(*)::integer as count from public.sp_write_authorization_receipts where plan_id=${preview.plan.id}`).toEqual([{ count: 0 }]);
        } else {
          await approve();
          const outbox = createSpWriteOutboxLedger(db); const runtime = createSpWriteRuntimeLedger(db);
          const claim = (await outbox.claimAvailable({ claimantId: 'synthetic-exposure-guard', kinds: ['dispatch'], limit: 10 }))
            .claims.find((candidate) => candidate.planId === preview.plan.id);
          if (claim?.kind !== 'dispatch') throw new Error('Synthetic exposure claim missing');
          const action = preview.plan.actions[0]!;
          const lease = await runtime.acquireDispatchLease({ claim, routeKey: action.routeKey });
          if (lease.kind !== 'acquired') throw new Error('Synthetic exposure lease missing');
          const [at] = await db.sql<{ now: string; until: string }[]>`select app.sp_write_instant(clock_timestamp()) as now,
            app.sp_write_instant(clock_timestamp()+interval '60 seconds') as until`;
          const identity = { planId: preview.plan.id, planFingerprint: preview.plan.fingerprint,
            executionId: claim.executionId, approvalId: claim.approvalId, generation: claim.generation };
          const observed = observedActionForSide(action, 'expected');
          const observation = SpWritePredispatchObservation.parse({ ...identity, schemaVersion: 'openspell.sp-write-predispatch-observation.v1',
            observationId: randomUUID(), routeKey: action.routeKey, observedAt: at!.now, validUntil: at!.until, items: [observed], fingerprint: '0'.repeat(64) });
          observation.fingerprint = hash(serializeSpWritePredispatchObservationFingerprint(observation));
          const intent = SpWriteProviderCallIntent.parse({ ...identity, schemaVersion: 'openspell.sp-write-provider-call-intent.v1', intentId: randomUUID(),
            providerCallId: randomUUID(), routeKey: action.routeKey, attemptNumber: 1, dispatchLeaseId: lease.leaseId,
            providerObservationFingerprint: observation.fingerprint, requestFingerprint: '0'.repeat(64), recordedAt: at!.now,
            positions: [{ requestIndex: 0, actionId: action.actionId, actionFingerprint: action.fingerprint,
              amazonEntityId: observed.amazonEntityId, actionRequestFingerprint: hash(JSON.stringify(action.changes)) }], fingerprint: '0'.repeat(64) });
          intent.requestFingerprint = hash(serializeSpWriteProviderRequestFingerprint(intent));
          intent.fingerprint = hash(serializeSpWriteProviderCallIntentFingerprint(intent));
          await changeExposure(control);
          expect(await runtime.reserveProviderCall({ claim, observation, intent })).toMatchObject({ kind: 'closed_without_dispatch', reason: 'source_changed' });
          expect(await db.sql`select reason::text from public.sp_write_predispatch_dispositions where plan_id=${preview.plan.id}`).toEqual([{ reason: 'source_changed' }]);
        }
      }
      expect(await db.sql`select count(*)::integer as count from public.sp_write_provider_call_intents where plan_id=${request.requestId}`).toEqual([{ count: 0 }]);
    });

  it('persists every ordered action once, replays the preview, and refuses a draft approval', async () => {
    const request = await source();
    const preview = await withAuthenticatedOrgEditor(db, { orgId, userId: USER }, (context) => previewSpWriteForActor(context, request));
    expect(preview.plan.counts).toMatchObject({ logicalChanges: 3, providerRows: 3, uniqueEntities: 2 });
    expect(await db.sql`select action_id,action_index from public.sp_write_plan_actions where plan_id=${preview.plan.id} order by action_index`)
      .toEqual(preview.plan.actions.map((action, index) => ({ action_id: action.actionId, action_index: index })));
    expect(await withAuthenticatedOrgEditor(db, { orgId, userId: USER }, (context) => previewSpWriteForActor(context, request))).toEqual(preview);
    await expect(withAuthenticatedOrgEditor(db, { orgId, userId: USER }, (context) => approveSpWriteForActor(context, {
      profileId, confirmation: 'Yes, apply 3 changes to Amazon', approval: { approvalRequestId: randomUUID(), plan: preview.binding,
        approvalMode: 'manual', confirmationVersion: 'openspell.amazon-sp-write-confirmation.v1', boundedAuthorization: null, preapprovedInversePlan: null },
    }))).rejects.toThrow('method_not_executable');
    expect(await db.sql`select count(*)::integer as count from public.sp_write_execution_requests where plan_id=${preview.plan.id}`).toEqual([{ count: 0 }]);
  });

  it.each(['placement value', 'complete context', 'trace hash', 'dependency text'] as const)('refuses rehashed forged %s through the authenticated persistence function', async (kind) => {
    const request = await source();
    const built = await buildSpWriteLegacyPreview(db.sql, orgId, request);
    const evidence = SpWriteDependencyPreviewEvidence.parse(built.evidence);
    const plan = structuredClone(built.plan);
    if (kind === 'placement value') {
      for (const [index, action] of plan.actions.entries()) {
        if (action.routeKey !== 'sp.v3.campaigns.update' || action.changes.placement === undefined) continue;
        action.changes.placement.requested.placements.topOfSearch = 350;
        if (index > 1) action.changes.placement.expected.placements.topOfSearch = 350;
      }
    } else if (kind === 'complete context') {
      const group = evidence.provenance.dependencySets[0]!;
      const snapshot = JSON.parse(group.calculationSnapshotText) as CoordinatedMethodInput;
      snapshot.campaignEvidence.currentControls!.offAmazonBudgetControlStrategy = 'SYNTHETIC_CHANGED';
      group.calculationSnapshotText = JSON.stringify(snapshot);
      group.calculationSnapshotSha256 = hash(group.calculationSnapshotText);
      for (const action of plan.actions) if (action.routeKey === 'sp.v3.campaigns.update' && action.changes.placement !== undefined) {
        action.changes.placement.expected.offAmazonBudgetControlStrategy = 'SYNTHETIC_CHANGED';
        action.changes.placement.requested.offAmazonBudgetControlStrategy = 'SYNTHETIC_CHANGED';
      }
    } else if (kind === 'trace hash') {
      evidence.provenance.rows[0]!.method.traceSha256 = '1'.repeat(64);
    } else {
      const group = evidence.provenance.dependencySets[0]!;
      const dependency = DependencySet.parse(JSON.parse(group.dependencySetText));
      dependency.precedenceReasons[0] = 'Forged after calculation.';
      group.dependencySetText = JSON.stringify(dependency);
      group.dependencySetSha256 = hash(group.dependencySetText);
      plan.dependencySets![0]!.dependencySetSha256 = group.dependencySetSha256;
      plan.dependencySets![0]!.precedenceReasons = dependency.precedenceReasons;
    }
    rehash(plan, evidence);
    await expect(record(plan, evidence)).rejects.toMatchObject({ code: '55000' });
    expect(await db.sql`select count(*)::integer as count from public.sp_write_plans where plan_id=${plan.id}`).toEqual([{ count: 0 }]);
  });

  it.each(['successful mirror', 'synchronized rebound', 'supporting bid drift', 'unchanged mode drift'] as const)('rechecks dependency authority after %s', async (mode) => {
    async function synchronizeBid(amount: number) {
      await db.sql.begin(async (sql) => {
        const [time] = await sql<{ now: string }[]>`select app.sp_write_instant(clock_timestamp()) as now`;
        await sql`select set_config('app.keyword_bid_read_started_at',${time!.now},true)`;
        await sql`update public.keywords set bid=${amount},bid_observed_at=${time!.now}::timestamptz
          where org_id=${orgId} and profile_id=${profileId} and amazon_id='kw-1'`;
      });
    }
    await synchronizeBid(0.6);
    const request = await source({ extraBid: mode === 'supporting bid drift' });
    const preview = await withAuthenticatedOrgEditor(db, { orgId, userId: USER }, (context) => previewSpWriteForActor(context, request));
    await db.sql`update app.sp_write_method_releases set release_state='pilot' where method_id='sp.coordinated-efficiency' and method_version='candidate.1'`;
    try {
      await withAuthenticatedOrgEditor(db, { orgId, userId: USER }, (context) => approveSpWriteForActor(context, {
        profileId, confirmation: 'Yes, apply 3 changes to Amazon', approval: { approvalRequestId: randomUUID(), plan: preview.binding,
          approvalMode: 'manual', confirmationVersion: 'openspell.amazon-sp-write-confirmation.v1', boundedAuthorization: null, preapprovedInversePlan: null },
      }));
      const outbox = createSpWriteOutboxLedger(db); const runtime = createSpWriteRuntimeLedger(db);
      const claims = await outbox.claimAvailable({ claimantId: 'synthetic-dependency-authority', kinds: ['dispatch'], limit: 10 });
      const claim = claims.claims.find((candidate) => candidate.planId === preview.plan.id);
      if (claim?.kind !== 'dispatch') throw new Error('Synthetic claim missing');
      const identity = { planId: preview.plan.id, planFingerprint: preview.plan.fingerprint,
        executionId: claim.executionId, approvalId: claim.approvalId, generation: claim.generation };
      async function clock() {
        const [value] = await db.sql<{ now: string; until: string }[]>`select app.sp_write_instant(clock_timestamp()) as now,
          app.sp_write_instant(clock_timestamp()+interval '60 seconds') as until`;
        return value!;
      }
      async function artifacts(index: number, leaseId: string) {
        const action = preview.plan.actions[index]!; const at = await clock();
        const observed = observedActionForSide(action, 'expected');
        const observation = SpWritePredispatchObservation.parse({ ...identity, schemaVersion: 'openspell.sp-write-predispatch-observation.v1',
          observationId: randomUUID(), routeKey: action.routeKey, observedAt: at.now, validUntil: at.until, items: [observed], fingerprint: '0'.repeat(64) });
        observation.fingerprint = hash(serializeSpWritePredispatchObservationFingerprint(observation));
        const intent = SpWriteProviderCallIntent.parse({ ...identity, schemaVersion: 'openspell.sp-write-provider-call-intent.v1', intentId: randomUUID(),
          providerCallId: randomUUID(), routeKey: action.routeKey, attemptNumber: 1, dispatchLeaseId: leaseId,
          providerObservationFingerprint: observation.fingerprint, requestFingerprint: '0'.repeat(64), recordedAt: at.now,
          positions: [{ requestIndex: 0, actionId: action.actionId, actionFingerprint: action.fingerprint,
            amazonEntityId: observed.amazonEntityId, actionRequestFingerprint: hash(JSON.stringify(action.changes)) }], fingerprint: '0'.repeat(64) });
        intent.requestFingerprint = hash(serializeSpWriteProviderRequestFingerprint(intent));
        intent.fingerprint = hash(serializeSpWriteProviderCallIntentFingerprint(intent));
        return { observation, intent };
      }
      const campaignLease = await runtime.acquireDispatchLease({ claim, routeKey: 'sp.v3.campaigns.update' });
      const bidLease = await runtime.acquireDispatchLease({ claim, routeKey: 'sp.v3.keywords.update' });
      if (campaignLease.kind !== 'acquired' || bidLease.kind !== 'acquired') throw new Error('Synthetic lease missing');
      expect((await runtime.reserveProviderCall({ claim, ...await artifacts(1, campaignLease.leaseId) })).kind).toBe('defer_and_reobserve');
      const first = await artifacts(0, bidLease.leaseId);
      const reserved = await runtime.reserveProviderCall({ claim, ...first });
      if (reserved.kind !== 'dispatch_once') throw new Error('Synthetic first reservation missing');
      const action = preview.plan.actions[0]!;
      const result = SpWriteProviderResult.parse({ schemaVersion: 'openspell.sp-write-provider-result.v1', resultId: reserved.ticket.resultId,
        intentId: first.intent.intentId, intentFingerprint: first.intent.fingerprint, providerCallId: first.intent.providerCallId,
        requestFingerprint: first.intent.requestFingerprint, completedAt: (await clock()).now,
        positions: [{ ...first.intent.positions[0], outcome: 'accepted', providerEntityId: first.intent.positions[0]!.amazonEntityId,
          code: null, message: null }].map(({ amazonEntityId: _entity, ...position }) => position), fingerprint: '0'.repeat(64) });
      result.fingerprint = hash(serializeSpWriteProviderResultFingerprint(result));
      expect(await runtime.appendProviderResult(result)).toBe('recorded');
      expect((await runtime.reserveProviderCall({ claim, ...await artifacts(1, campaignLease.leaseId) })).kind).toBe('defer_and_reobserve');
      const observedClaims = await outbox.claimAvailable({ claimantId: 'synthetic-dependency-observer', kinds: ['observe_and_recover'], limit: 10 });
      const observer = observedClaims.claims.find((candidate) => candidate.planId === preview.plan.id);
      if (observer?.kind !== 'observe_and_recover') throw new Error('Synthetic observer missing');
      const observation = SpWriteObservation.parse({ ...identity, schemaVersion: 'openspell.sp-write-observation.v1', observationId: randomUUID(),
        intentId: first.intent.intentId, intentFingerprint: first.intent.fingerprint, providerCallId: first.intent.providerCallId,
        requestFingerprint: first.intent.requestFingerprint, actionId: action.actionId, actionFingerprint: action.fingerprint,
        routeKey: action.routeKey, sourceSyncJobId: observer.sourceSyncJobId, observedAt: (await clock()).now,
        outcome: 'observed_requested', observed: observedActionForSide(action, 'requested'), fingerprint: '0'.repeat(64) });
      observation.fingerprint = hash(serializeSpWriteObservationFingerprint(observation));
      await runtime.appendObservation(observation);
      expect((await runtime.reserveProviderCall({ claim, ...await artifacts(1, campaignLease.leaseId) })).kind).toBe('defer_and_reobserve');
      expect(await settleSpWriteDependencies(db, claim)).toEqual({ kind: 'unchanged' });
      expect((await reconcileSpWriteObservation(db, observation)).outcome).toBe('promoted');
      if (mode !== 'successful mirror') {
        if (mode === 'synchronized rebound') await synchronizeBid(0.6);
        else await changeExposure(mode === 'supporting bid drift' ? 'supporting bid' : 'mode');
        const reason = 'source_changed';
        expect(await runtime.reserveProviderCall({ claim, ...await artifacts(1, campaignLease.leaseId) }))
          .toMatchObject({ kind: 'closed_without_dispatch', reason });
        expect(await db.sql`select reason::text from public.sp_write_predispatch_dispositions
          where plan_id=${preview.plan.id} order by action_id`).toEqual(expect.arrayContaining([{ reason }, { reason: mode === 'synchronized rebound' ? reason : 'dependency_failed' }]));
      } else {
        expect((await runtime.reserveProviderCall({ claim, ...await artifacts(1, campaignLease.leaseId) })).kind).toBe('dispatch_once');
      }
      const state = await runtime.loadVerifiedExecution(claim);
      expect(state?.providerCallIntents).toHaveLength(mode === 'successful mirror' ? 2 : 1);
      expect(state?.observations).toHaveLength(1);
      expect(await db.sql`select count(*)::integer as count from public.sp_write_mirror_observations where plan_id=${preview.plan.id}`).toEqual([{ count: 1 }]);
    } finally {
      await db.sql`update app.sp_write_method_releases set release_state='draft' where method_id='sp.coordinated-efficiency' and method_version='candidate.1'`;
    }
  });

});
