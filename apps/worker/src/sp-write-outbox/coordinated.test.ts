import { SP_MARKETPLACE_MONEY_RULES } from '@wizard-ads/shared';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type SpWriteAdapter } from '@wizard-ads/ads-api/sp-write-adapter';
import { spCoordinatedCapabilities, resolveMethod } from '@wizard-ads/core';
import { exportAcceptedRecommendations, withAuthenticatedOrgEditor, withAuthenticatedReadSnapshot } from '@wizard-ads/db';
import { previewSpWriteForActor, approveSpWriteForActor, readRecordedSpWritePreviewForActor } from '@wizard-ads/db/sp-write-application';
import { createSpWriteOutboxLedger, createSpWriteRuntimeLedger } from '@wizard-ads/db/sp-write-persistence';
import { reconcileSpWriteObservation, readSpWriteDatabaseTime } from '@wizard-ads/db/sp-write-worker';
import { createTestDatabase, readSpWriteOperation, type TestDatabase } from '@wizard-ads/db/testing';
import { COORDINATED_METHOD, type CoordinatedMethodInput } from '@wizard-ads/shared';
import type { SpWriteAdmission, SpWritePreview } from '@wizard-ads/shared/sp-write-application';
import { serializeSpWritePredispatchObservationFingerprint, serializeSpWriteProviderCallIntentFingerprint,
  serializeSpWriteProviderRequestFingerprint, type SpWriteObservation, type SpWritePlan } from '@wizard-ads/shared/sp-writes';
import { hasher, makeReservationArtifacts, providerKey } from './artifacts.js';
import { createSpWriteOutboxLoop } from './loop.js';
import { createGuardedSpWriteAdapter } from './guarded-provider-fetch.js';

const [marketplaceId, moneyRule] = Object.entries(SP_MARKETPLACE_MONEY_RULES).find(([, rule]) => rule.currencyCode === 'USD')!;
const marketplaceScope = { marketplaceId, region: moneyRule.region, currencyCode: moneyRule.currencyCode };

const OWNER = '31313131-3131-4131-8131-313131313131';

function calculation(profileId: string, runId: string): CoordinatedMethodInput {
  return {
    runId, profileId, methodId: COORDINATED_METHOD.id, methodVersion: COORDINATED_METHOD.version,
    window: { start: '2026-08-01', end: '2026-08-28' }, admittedAt: '2026-09-10T00:00:00Z',
    methodParameters: { targetAcos: 0.3, caps: { maxIncrease: 0.5, maxDecrease: 0.6 },
      floors: { manualMinBid: 0.1 }, ceilings: { manualMaxBid: 1 }, exposureCeiling: 1.5,
      minClicksPerPlacement: 20, placementEvidenceRequirements: 'single_target' },
    resolvedSettings: Object.fromEntries(Object.entries({ targetAcos: 0.3, bidFloor: 0.1, bidCeiling: 1,
      bidIncreaseCap: 0.5, bidDecreaseCap: 0.6, exposureCeiling: 1.5, minClicksPerPlacement: 20,
      placementEvidenceRequirements: 'single_target' }).map(([name, value]) => [name, { value, source: 'run', sourceLabel: 'Synthetic run' }])),
    evidenceRows: [{ entityRef: { profileId, campaignId: 'c-1', adGroupId: 'ag-1', entityId: 'kw-1', entityType: 'keyword', adProduct: 'SP' },
      adProduct: 'SP', currentBid: 0.6, metrics: { clicks: 100, sales: 260, orders: 10, cost: 90 },
      levels: { profile: { clicks: 100, sales: 260, orders: 10 } }, stock: { status: 'in_stock', asins: [] } }],
    campaignEvidence: { campaignId: 'c-1', costType: 'cpc', complete: true,
      targetCount: 1, attributionMature: true, homogeneousProxyValidation: null,
      currentControls: { strategy: 'manual', placements: { topOfSearch: 100, restOfSearch: 0, productPages: 0, amazonBusiness: null },
        shopperCohorts: [], offAmazonBudgetControlStrategy: null },
      capabilities: spCoordinatedCapabilities(marketplaceScope),
      placementFacts: [
        { campaignId: 'c-1', placement: 'top_of_search', clicks: 40, sales: 160, clickShare: 0.4 },
        { campaignId: 'c-1', placement: 'rest_of_search', clicks: 40, sales: 80, clickShare: 0.4 },
        { campaignId: 'c-1', placement: 'product_pages', clicks: 20, sales: 20, clickShare: 0.2 },
      ],
    },
  };
}

describe('ordered coordinated execution through the real ledger', () => {
  let database: TestDatabase;
  let orgId: string;
  let profileId: string;
  let preview: SpWritePreview;
  let admission: SpWriteAdmission;
  let adapter: SpWriteAdapter;
  let rejectFirst: boolean;
  let loseFirstResponse: boolean;
  let delayVisibility: boolean;
  let delayMirror: boolean;
  let providerBid: number;
  let placements: { placement: string; percentage: number }[];
  let events: string[];
  let mirrored: Set<string>;
  let attempts: number;
  let providerState: string | null;
  let omitArchivedValues: boolean;

  beforeEach(async (context) => {
    database = await createTestDatabase('coordinated_outbox');
    const [tenant] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture('coordinated-outbox', ${OWNER}, 'owner') as id`;
    orgId = tenant!.id;
    const [profile] = await database.sql<{ id: string }[]>`select id from public.ad_profiles where org_id=${orgId}`;
    profileId = profile!.id;
    const ledger = createSpWriteOutboxLedger(database);
    const fixtureClaims = await ledger.claimAvailable({ claimantId: 'synthetic-fixture-cleanup', kinds: ['observe_and_recover'], limit: 1 });
    expect(fixtureClaims.claimedCount).toBe(1);
    expect((await ledger.completeClaim(fixtureClaims.claims[0]!)).kind).toBe('completed');
    const grantVersion = randomUUID();
    await database.sql`insert into public.sp_write_profile_grant_versions
      (grant_id,version_id,org_id,profile_id,enabled,amazon_profile_id,connection_id,region,marketplace_id,currency_code,api_dialect,created_by)
      select grant_id,${grantVersion},org_id,profile_id,true,amazon_profile_id,connection_id,region,'ATVPDKIKX0DER',currency_code,api_dialect,created_by
      from public.sp_write_profile_grant_versions where org_id=${orgId} and profile_id=${profileId}`;
    await database.sql`update public.sp_write_profile_grant_heads set version_id=${grantVersion} where org_id=${orgId} and profile_id=${profileId}`;
    const gateVersion = randomUUID();
    await database.sql`insert into public.sp_write_environment_gate_versions(version_id,enabled,max_unresolved_calls) values(${gateVersion},true,1)`;
    await database.sql`insert into public.sp_write_environment_gate_head(singleton,version_id) values(true,${gateVersion})`;
    // Only this disposable database installs a pilot release. The runtime catalogue remains draft.
    await database.sql`update app.sp_write_method_releases set release_state='pilot'
      where method_id=${COORDINATED_METHOD.id} and method_version=${COORDINATED_METHOD.version}`;
    expect(resolveMethod(COORDINATED_METHOD.id, COORDINATED_METHOD.version).descriptor.releaseState).toBe('draft');
    await database.sql`update public.keywords set bid=0.6 where org_id=${orgId} and profile_id=${profileId} and amazon_id='kw-1'`;
    await database.sql`update public.campaigns
      set bidding_strategy='manual',placement_bidding='{"topOfSearch":100,"restOfSearch":0,"productPages":0}'::jsonb
      where org_id=${orgId} and profile_id=${profileId} and amazon_id='c-1'`;
    const runId = randomUUID();
    const snapshot = calculation(profileId, runId);
    if (context.task.name.includes('target bid')) {
      snapshot.evidenceRows[0]!.entityRef.entityType = 'target';
      snapshot.evidenceRows[0]!.entityRef.entityId = 'tg-1';
    }
    {
      await database.sql.begin(async (sql) => {
        const [clock] = await sql<{ observed_at: string }[]>`select (clock_timestamp()-interval '1 minute')::text as observed_at`;
        await sql`select set_config('app.campaign_control_read_started_at',${clock!.observed_at},true)`;
        await sql`update public.campaigns
          set bidding_control_state=${JSON.stringify(snapshot.campaignEvidence.currentControls)}::text::jsonb,
              bidding_observed_at=${clock!.observed_at}::timestamptz
          where org_id=${orgId} and profile_id=${profileId} and amazon_id='c-1'`;
      });
    }
    // The complete single-target snapshot excludes the unrelated seed target type.
    if (snapshot.evidenceRows[0]!.entityRef.entityType === 'target') {
      await database.sql`update public.keywords set state='archived' where org_id=${orgId} and profile_id=${profileId}`;
    } else {
      await database.sql`update public.targets set state='archived' where org_id=${orgId} and profile_id=${profileId}`;
    }
    const result = resolveMethod(snapshot.methodId, snapshot.methodVersion).evaluate(snapshot);
    if (result.kind !== 'proposal' || result.dependencySet === undefined) throw new Error('Synthetic coordinated proposal missing');
    expect(result.dependencySet.changes).toHaveLength(3);
    const jobId = randomUUID();
    await database.sql.begin(async (sql) => {
      await sql`insert into public.sync_jobs(id,org_id,profile_id,job_type,payload,status,started_at,finished_at)
        values(${jobId},${orgId},${profileId},'recommendations.run',
          ${JSON.stringify({ type: 'recommendations.run', orgId, profileId, runId, lookbackDays: 28 })}::text::jsonb,
          'succeeded',clock_timestamp(),clock_timestamp())`;
      await sql`insert into public.recommendation_runs
        (id,org_id,profile_id,status,lookback_days,method_id,method_version,strategy_snapshot,strategy_goal,
          scope_version,scope_count,scope_fingerprint,job_id,execution_lineage)
        select ${runId},org_id,profile_id,'succeeded',28,${COORDINATED_METHOD.id},${COORDINATED_METHOD.version},
          strategy_snapshot,strategy_goal,1,1,app.recommendation_run_scope_fingerprint(${profileId}::uuid,null,array['c-1']),${jobId},'queue'
        from public.recommendation_runs where org_id=${orgId} and profile_id=${profileId} limit 1`;
      await sql`insert into public.recommendation_run_campaigns(org_id,profile_id,run_id,campaign_id)
        values(${orgId},${profileId},${runId},'c-1')`;
    });
    await database.sql`insert into public.audit_log(org_id,actor_type,action,target_type,target_id,payload,source)
      values(${orgId},'service','recommendation.run.succeeded','recommendation_run',${runId},
        ${JSON.stringify({ narrative: { calculationSnapshots: [snapshot] } })}::text::jsonb,'worker')`;
    const recommendationId = randomUUID();
    await database.sql`insert into public.recommendations
      (id,run_id,org_id,profile_id,reason,entity_type,entity_id,ad_product,campaign_id,field,current_value,proposed_value,inputs,status)
      values(${recommendationId},${runId},${orgId},${profileId},'high_acos','campaign','c-1','SP','c-1','control_set',null,null,
        ${JSON.stringify(result.changes[0]!.inputs)}::text::jsonb,'accepted')`;
    const exported = await withAuthenticatedOrgEditor(database, { orgId, userId: OWNER }, (context) =>
      exportAcceptedRecommendations(context, { orgId, profileId, runId, ids: [recommendationId],
        tag: randomUUID(), optGroup: 'synthetic', lever: 'coordinated', note: 'Synthetic dependency execution', actorId: OWNER }));
    preview = await withAuthenticatedOrgEditor(database, { orgId, userId: OWNER }, (context) =>
      previewSpWriteForActor(context, { requestId: randomUUID(), profileId, applyBatchId: exported.batchId }));
    expect(preview.plan.counts).toMatchObject({ logicalChanges: 3, providerRows: 3, uniqueEntities: 2 });
    admission = await withAuthenticatedOrgEditor(database, { orgId, userId: OWNER }, (context) =>
      approveSpWriteForActor(context, { profileId, confirmation: 'Yes, apply 3 changes to Amazon', approval: {
        approvalRequestId: randomUUID(), plan: preview.binding, approvalMode: 'manual',
        confirmationVersion: 'openspell.amazon-sp-write-confirmation.v1', boundedAuthorization: null, preapprovedInversePlan: null,
      } }));
    events = []; mirrored = new Set(); attempts = 0; rejectFirst = false; loseFirstResponse = false;
    delayVisibility = false; delayMirror = false;
    providerState = 'ENABLED'; omitArchivedValues = false;
    providerBid = 0.6;
    placements = [{ placement: 'PLACEMENT_TOP', percentage: 100 }, { placement: 'PLACEMENT_REST_OF_SEARCH', percentage: 0 }, { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: 0 }];
    const secret = ['synthetic', 'secret'].join('-');
    const http = createGuardedSpWriteAdapter({ region: 'NA', credentials: { clientId: 'synthetic-client', clientSecret: secret, refreshToken: ['synthetic', 'refresh'].join('-') },
      fetch: async (url, init = {}) => {
        if (url.endsWith('/auth/o2/token')) return Response.json({ access_token: 'synthetic', expires_in: 3600 });
        const body = JSON.parse(String(init.body));
        if (init.method === 'PUT') {
          attempts += 1;
          const kind = url.endsWith('/sp/keywords') ? 'keywords' : url.endsWith('/sp/targets') ? 'targetingClauses' : 'campaigns';
          const rows = body[kind] as Array<{ keywordId?: string; targetId?: string; campaignId?: string; bid?: number; dynamicBidding?: { placementBidding: typeof placements } }>;
          expect(rows).toHaveLength(1);
          const row = rows[0]!;
          if (rejectFirst && kind === 'keywords') return Response.json({ keywords: { success: [], error: [{ index: 0,
            errors: [{ errorType: 'RANGE_ERROR', errorValue: { rangeError: { message: 'Synthetic rejection', reason: 'TOO_LOW' } } }] }] } }, { status: 207 });
          if (kind !== 'campaigns') providerBid = row.bid!;
          else placements = row.dynamicBidding!.placementBidding;
          if (loseFirstResponse && kind === 'keywords') throw new TypeError('Synthetic response interrupted');
          const providerId = kind === 'keywords' ? { keywordId: row.keywordId }
            : kind === 'targetingClauses' ? { targetId: row.targetId } : { campaignId: row.campaignId };
          return Response.json({ [kind]: { success: [{ index: 0, ...providerId }], error: [] } }, { status: 207 });
        }
        if (url.endsWith('/sp/keywords/list')) return Response.json({ keywords: [{ keywordId: 'kw-1', bid: delayVisibility ? 0.6 : providerBid, state: 'ENABLED' }] });
        const state = providerState === null ? {} : { state: providerState };
        if (url.endsWith('/sp/targets/list')) return Response.json({ targetingClauses: [{ targetId: 'tg-1',
          ...(providerState === 'ARCHIVED' && omitArchivedValues ? {} : { bid: delayVisibility ? 0.6 : providerBid }), ...state }] });
        if (url.endsWith('/sp/campaigns/list')) return Response.json({ campaigns: [{ campaignId: 'c-1', ...state,
          ...(providerState === 'ARCHIVED' && omitArchivedValues ? {} : { dynamicBidding: { strategy: 'MANUAL', placementBidding: placements, shopperCohortBidding: [] } }) }] });
        throw new Error('Unexpected synthetic provider route');
      },
    }, { hasher });
    adapter = {
      preparePlan: (...args) => http.preparePlan(...args),
      observeCurrent: (...args) => http.observeCurrent(...args),
      observeAfterWrite: async (...args) => {
        const items = await http.observeAfterWrite(...args);
        const step = preview.plan.actions.findIndex((action) => action.actionId === args[0].call.positions[0]!.actionId) + 1;
        if (!delayVisibility) events.push(`observe:${step}`);
        return items;
      },
      executeOneAttempt: async (...args) => {
        const step = preview.plan.actions.findIndex((action) => action.actionId === args[0].intent.positions[0]!.actionId) + 1;
        events.push(`attempt:${step}`);
        return http.executeOneAttempt(...args);
      },
    };
  }, 60_000);

  afterEach(async () => { await database?.drop(); });

  function worker() {
    return createSpWriteOutboxLoop({ database, claimantId: `synthetic-coordinated-${randomUUID()}`,
      policy: () => ({ dispatchEnabled: true, reconcileEnabled: true, profileIds: [profileId], planIds: [preview.plan.id] }),
      prepareProviders: async (plans: readonly SpWritePlan[]) => new Map(plans.map((plan) => [providerKey(plan), adapter])),
      reconcileObservation: async (observation: SpWriteObservation) => {
        if (delayMirror) return false;
        const receipt = await reconcileSpWriteObservation(database, observation);
        if (!mirrored.has(observation.actionId)) {
          mirrored.add(observation.actionId);
          events.push(`mirror:${preview.plan.actions.findIndex((action) => action.actionId === observation.actionId) + 1}`);
        }
        return ['promoted', 'already_current', 'superseded', 'missing'].includes(receipt.outcome);
      },
    });
  }

  const detail = () => readSpWriteOperation(database, { orgId, userId: OWNER }, { profileId, ...admission.operation });
  const recorded = () => withAuthenticatedReadSnapshot(database, { orgId, userId: OWNER }, (context) =>
    readRecordedSpWritePreviewForActor(context, { profileId, planId: preview.plan.id }));
  async function drain(expected: string) {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const current = worker();
      const result = await current.tick();
      current.stop();
      expect(result.kind).not.toBe('fault');
      const status = await detail();
      if (status.snapshot.status === expected && status.mirror.pending === 0
        && status.snapshot.accounting.pendingDispatch === 0 && status.snapshot.accounting.pendingObservation === 0) return status;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Synthetic coordinated execution did not settle');
  }

  it.each(['keyword bid', 'target bid'])('counts three ordered attempts and observations for %s across competing workers and restarts', async () => {
    const first = worker(); const second = worker();
    const ticks = await Promise.all([first.tick(), second.tick()]);
    first.stop(); second.stop();
    expect(ticks.reduce((sum, tick) => sum + tick.attemptedCalls, 0), JSON.stringify(ticks)).toBe(1);
    const complete = await drain('succeeded');
    expect(complete.snapshot.accounting).toMatchObject({ approvedRows: 3, intentCommitted: 3, providerAccepted: 3,
      observedRequested: 3, pendingDispatch: 0, pendingObservation: 0, providerCallsCommitted: 3, providerCallsCompleted: 3 });
    expect(complete.mirror).toMatchObject({ observations: 3, pending: 0 });
    expect(events).toEqual(['attempt:1', 'observe:1', 'mirror:1', 'attempt:2', 'observe:2', 'mirror:2', 'attempt:3', 'observe:3', 'mirror:3']);
    expect({ requested: preview.plan.counts.providerRows, attempted: attempts, observed: mirrored.size }).toEqual({ requested: 3, attempted: 3, observed: 3 });
    expect((await worker().tick()).attemptedCalls).toBe(0);
    expect(attempts).toBe(3);
    const campaignHead = () => database.sql<{ controls: unknown; observed_at: Date }[]>`select
      bidding_control_state as controls,bidding_observed_at as observed_at
      from public.campaigns where org_id=${orgId} and profile_id=${profileId} and amazon_id='c-1'`;
    const beforeStaleSync = await campaignHead();
    await expect(database.sql`update public.campaigns
      set placement_bidding='{"topOfSearch":100,"restOfSearch":0,"productPages":0}'::jsonb
      where org_id=${orgId} and profile_id=${profileId} and amazon_id='c-1'`).rejects.toMatchObject({ code: '55000' });
    expect(await campaignHead()).toEqual(beforeStaleSync);
    const finalAction = preview.plan.actions[2]!;
    if (finalAction.routeKey !== 'sp.v3.campaigns.update') throw new Error('Synthetic final placement missing');
    expect(beforeStaleSync[0]!.controls).toEqual(finalAction.changes.placement!.requested);
    if (preview.plan.actions[0]!.routeKey === 'sp.v3.targets.update') {
      const targetHead = () => database.sql`select bid,bid_observed_at from public.targets
        where org_id=${orgId} and profile_id=${profileId} and amazon_id='tg-1'`;
      const beforeStaleTargetSync = await targetHead();
      await expect(database.sql`update public.targets set bid=0.6
        where org_id=${orgId} and profile_id=${profileId} and amazon_id='tg-1'`).rejects.toMatchObject({ code: '55000' });
      expect(await targetHead()).toEqual(beforeStaleTargetSync);
    }
  }, 180_000);

  it('records a failed predecessor and refuses its later steps without attempting them', async () => {
    rejectFirst = true;
    const complete = await drain('partial');
    expect(complete.snapshot.accounting).toMatchObject({ approvedRows: 3, intentCommitted: 1, providerRejected: 1,
      refusedBeforeDispatch: 2, observedRequested: 0, pendingDispatch: 0, pendingObservation: 0 });
    const refusals = await database.sql<{ reason: string }[]>`select reason::text from public.sp_write_predispatch_dispositions
      where plan_id=${preview.plan.id} order by action_id`;
    expect(refusals).toEqual([{ reason: 'dependency_failed' }, { reason: 'dependency_failed' }]);
    expect(events).toEqual(['attempt:1']); expect(attempts).toBe(1);
    expect((await worker().tick()).attemptedCalls).toBe(0);
  }, 180_000);

  it('observes an ambiguous predecessor after restart without retrying its provider call', async () => {
    loseFirstResponse = true;
    expect((await worker().tick()).attemptedCalls).toBe(1);
    const complete = await drain('observed_after_ambiguous');
    expect(complete.snapshot.accounting).toMatchObject({ approvedRows: 3, intentCommitted: 3,
      providerAmbiguous: 1, observedRequested: 3, providerCallsCommitted: 3, providerCallsCompleted: 3 });
    expect(events).toEqual(['attempt:1', 'observe:1', 'mirror:1', 'attempt:2', 'observe:2', 'mirror:2', 'attempt:3', 'observe:3', 'mirror:3']);
    expect((await worker().tick()).attemptedCalls).toBe(0);
    expect(attempts).toBe(3);
  }, 180_000);

  it('waits for provider observation and mirror persistence before the next step', async () => {
    delayVisibility = true;
    expect((await worker().tick()).attemptedCalls).toBe(1);
    expect((await worker().tick()).attemptedCalls).toBe(0);
    expect((await detail()).snapshot.accounting).toMatchObject({ intentCommitted: 1, pendingObservation: 1, pendingDispatch: 2 });
    expect(attempts).toBe(1);
    delayVisibility = false; delayMirror = true;
    const deadline = Date.now() + 35_000;
    while ((await detail()).snapshot.accounting.observedRequested === 0 && Date.now() < deadline) {
      expect((await worker().tick()).attemptedCalls).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect((await detail()).mirror.pending).toBe(1);
    expect(attempts).toBe(1);
    delayMirror = false;
    expect((await drain('succeeded')).snapshot.accounting.observedRequested).toBe(3);
    expect(attempts).toBe(3);
  }, 180_000);

  it('refuses a direct successor reservation while the predecessor is unobserved', async () => {
    const ledger = createSpWriteOutboxLedger(database); const runtime = createSpWriteRuntimeLedger(database);
    const [claim] = (await ledger.claimAvailable({ claimantId: 'synthetic-skip-step', kinds: ['dispatch'], limit: 1 })).claims;
    if (claim?.kind !== 'dispatch') throw new Error('Synthetic dispatch claim missing');
    const evidence = await runtime.loadVerifiedExecution(claim);
    if (evidence === null) throw new Error('Synthetic execution evidence missing');
    const call = adapter.preparePlan(evidence.plan, [evidence.plan.actions[1]!.actionId])[0]!;
    const lease = await runtime.acquireDispatchLease({ claim, routeKey: call.routeKey });
    if (lease.kind !== 'acquired') throw new Error('Synthetic lease missing');
    const items = await adapter.observeCurrent({ plan: evidence.plan, call });
    const artifacts = makeReservationArtifacts(evidence, call, lease.leaseId, items, await readSpWriteDatabaseTime(database));
    const [canonical] = await database.sql<{ decision: string }[]>`select decision from app.reserve_sp_write_provider_call(
      ${claim.executionId}::uuid,${claim.planId}::uuid,${claim.generation}::uuid,${lease.leaseId}::uuid,
      ${JSON.stringify(artifacts.observation)},${serializeSpWritePredispatchObservationFingerprint(artifacts.observation)},
      ${JSON.stringify(artifacts.intent)},${serializeSpWriteProviderRequestFingerprint(artifacts.intent)},
      ${serializeSpWriteProviderCallIntentFingerprint(artifacts.intent)})`;
    expect(canonical!.decision).toBe('busy');
    expect((await runtime.reserveProviderCall({ claim, ...artifacts })).kind).not.toBe('dispatch_once');
    expect((await runtime.loadVerifiedExecution(claim))?.providerCallIntents).toHaveLength(0);
    expect(attempts).toBe(0);
  });

  it.each(['ARCHIVED', 'UNKNOWN', null])('defers a target bid with provider state %s and keeps every step unattempted', async (state) => {
    providerState = state;
    expect((await worker().tick()).attemptedCalls).toBe(0);
    expect((await detail()).snapshot.accounting).toMatchObject({ intentCommitted: 0, pendingDispatch: 3 });
    expect(attempts).toBe(0);
    expect(events).toEqual([]);
  }, 60_000);

  it('keeps later campaign controls pending when raw campaign state is archived', async () => {
    providerState = 'ARCHIVED';
    expect((await worker().tick()).attemptedCalls).toBe(1);
    expect((await worker().tick()).attemptedCalls).toBe(0);
    expect(events).toEqual(['attempt:1', 'observe:1', 'mirror:1']);
    const placementCall = adapter.preparePlan(preview.plan, [preview.plan.actions[1]!.actionId])[0]!;
    await expect(adapter.observeCurrent({ plan: preview.plan, call: placementCall })).rejects.toThrow();
    expect((await worker().tick()).attemptedCalls).toBe(0);
    expect((await detail()).snapshot.accounting).toMatchObject({ intentCommitted: 1, observedRequested: 1, pendingDispatch: 2 });
    expect(attempts).toBe(1);
  }, 60_000);

  it.each([false, true])('records archive after successful target bid with former values omitted %s and refuses descendants', async (omitValues) => {
    expect((await worker().tick()).attemptedCalls).toBe(1);
    providerState = 'ARCHIVED'; omitArchivedValues = omitValues;
    const complete = await drain('conflict');
    expect(complete.snapshot.accounting).toMatchObject({ approvedRows: 3, intentCommitted: 1, providerAccepted: 1,
      observationConflict: 1, observedRequested: 0, refusedBeforeDispatch: 2, pendingDispatch: 0, pendingObservation: 0 });
    expect(complete.mirror).toMatchObject({ observations: 1, pending: 0, superseded: 1 });
    const [observation] = await database.sql<{ observed: { values: unknown }; outcome: string }[]>`
      select observed,outcome from public.sp_write_observations where plan_id=${preview.plan.id}`;
    expect(observation).toMatchObject({ outcome: 'conflict', observed: { values: { state: 'archived' } } });
    if (omitValues) expect(observation!.observed.values).toEqual({ state: 'archived' });
    const refusals = await database.sql<{ reason: string }[]>`select reason from public.sp_write_predispatch_dispositions
      where plan_id=${preview.plan.id}`;
    expect(refusals).toEqual([{ reason: 'dependency_failed' }, { reason: 'dependency_failed' }]);
    expect(events).toEqual(['attempt:1', 'observe:1', 'mirror:1']);
    expect(attempts).toBe(1);
  }, 180_000);

  it.each([false, true])('records archive after successful campaign placement with former values omitted %s and refuses descendants', async (omitValues) => {
    const deadline = Date.now() + 60_000;
    while (attempts < 2 && Date.now() < deadline) {
      expect((await worker().tick()).kind).not.toBe('fault');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(attempts).toBe(2);
    providerState = 'ARCHIVED'; omitArchivedValues = omitValues;
    const complete = await drain('conflict');
    expect(complete.snapshot.accounting).toMatchObject({ approvedRows: 3, intentCommitted: 2, providerAccepted: 2,
      observationConflict: 1, observedRequested: 1, refusedBeforeDispatch: 1, pendingDispatch: 0, pendingObservation: 0 });
    expect(complete.mirror).toMatchObject({ observations: 2, pending: 0, promoted: 1, superseded: 1 });
    const [observation] = await database.sql<{ observed: { values: unknown }; outcome: string }[]>`
      select observed,outcome from public.sp_write_observations where plan_id=${preview.plan.id}
      and action_id=${preview.plan.actions[1]!.actionId}`;
    expect(observation).toMatchObject({ outcome: 'conflict', observed: { values: { state: 'archived' } } });
    if (omitValues) expect(observation!.observed.values).toEqual({ state: 'archived' });
    const refusals = await database.sql<{ reason: string }[]>`select reason from public.sp_write_predispatch_dispositions
      where plan_id=${preview.plan.id}`;
    expect(refusals).toEqual([{ reason: 'dependency_failed' }]);
    expect(events).toEqual(['attempt:1', 'observe:1', 'mirror:1', 'attempt:2', 'observe:2', 'mirror:2']);
    expect(attempts).toBe(2);
  }, 180_000);

  it('resumes after crashing between predecessor mirror and the following step without repeating a write', async () => {
    const crashedWorker = worker();
    expect((await crashedWorker.tick()).attemptedCalls).toBe(1);
    expect((await crashedWorker.tick()).attemptedCalls).toBe(0);
    expect(events).toEqual(['attempt:1', 'observe:1', 'mirror:1']);
    expect((await detail()).snapshot.accounting).toMatchObject({ intentCommitted: 1, observedRequested: 1, pendingDispatch: 2 });
    crashedWorker.stop();
    const complete = await drain('succeeded');
    expect(complete.snapshot.accounting).toMatchObject({ intentCommitted: 3, observedRequested: 3, providerCallsCommitted: 3 });
    expect(events).toEqual(['attempt:1', 'observe:1', 'mirror:1', 'attempt:2', 'observe:2', 'mirror:2', 'attempt:3', 'observe:3', 'mirror:3']);
    expect(attempts).toBe(3);
  }, 180_000);

  it('reserves one initial provider call when two callers race the same immutable step', async () => {
    const ledger = createSpWriteOutboxLedger(database); const runtime = createSpWriteRuntimeLedger(database);
    const [claim] = (await ledger.claimAvailable({ claimantId: 'synthetic-concurrent-reservation', kinds: ['dispatch'], limit: 1 })).claims;
    if (claim?.kind !== 'dispatch') throw new Error('Synthetic dispatch claim missing');
    const evidence = await runtime.loadVerifiedExecution(claim);
    if (evidence === null) throw new Error('Synthetic execution missing');
    const call = adapter.preparePlan(evidence.plan, [evidence.plan.actions[0]!.actionId])[0]!;
    const lease = await runtime.acquireDispatchLease({ claim, routeKey: call.routeKey });
    if (lease.kind !== 'acquired') throw new Error('Synthetic lease missing');
    const items = await adapter.observeCurrent({ plan: evidence.plan, call });
    const first = makeReservationArtifacts(evidence, call, lease.leaseId, items, await readSpWriteDatabaseTime(database));
    const second = makeReservationArtifacts(evidence, call, lease.leaseId, items, await readSpWriteDatabaseTime(database));
    const outcomes = await Promise.all([runtime.reserveProviderCall({ claim, ...first }), runtime.reserveProviderCall({ claim, ...second })]);
    expect(outcomes.filter((outcome) => outcome.kind === 'dispatch_once')).toHaveLength(1);
    const reserved = await runtime.loadVerifiedExecution(claim);
    expect(reserved!.providerCallIntents).toHaveLength(1);
    expect(reserved!.providerCallIntents[0]!.positions.map((position) => position.actionId)).toEqual([preview.plan.actions[0]!.actionId]);
    expect(attempts).toBe(0);
  });

  it.each(['keyword bid', 'target bid'])('reads all three ordered current controls for %s and detects a changed source', async () => {
    const result = await recorded();
    expect(result.freshness).toMatchObject({ status: 'current', reasons: [] });
    expect(result.currentRows.map((row) => row.actionId)).toEqual(preview.plan.actions.map((action) => action.actionId));
    expect(result.currentRows).toHaveLength(3);
    expect(result.currentRows[0]!.observation?.routeKey).toBe(preview.plan.actions[0]!.routeKey);
    const first = preview.plan.actions[1]!; const second = preview.plan.actions[2]!;
    if (first.routeKey !== 'sp.v3.campaigns.update' || second.routeKey !== 'sp.v3.campaigns.update') throw new Error('Synthetic placements missing');
    for (const row of result.currentRows.slice(1)) {
      expect(row.observation).toMatchObject({ values: { placement: first.changes.placement!.expected } });
    }
    expect(second.changes.placement!.expected).toEqual(first.changes.placement!.requested);
    expect(second.changes.placement!.expected).not.toEqual(first.changes.placement!.expected);
    expect(result.preview).toEqual(preview);
    await database.sql`update public.apply_batches set note='Synthetic source changed'
      where id=${preview.plan.source.kind === 'apply_batch' ? preview.plan.source.applyBatchId : null}`;
    const changed = await recorded();
    expect(changed.freshness.reasons).toContain('source_changed');
    expect(changed.preview).toEqual(preview);
  });

  it('reports missing complete campaign state without filling it from placement projections', async () => {
    await database.sql.begin(async (sql) => {
      const [clock] = await sql<{ observed_at: string }[]>`select clock_timestamp()::text as observed_at`;
      await sql`select set_config('app.campaign_control_read_started_at',${clock!.observed_at},true)`;
      await sql`update public.campaigns set bidding_control_state=null,bidding_observed_at=${clock!.observed_at}::timestamptz
        where org_id=${orgId} and profile_id=${profileId} and amazon_id='c-1'`;
    });
    const result = await recorded();
    expect(result.freshness).toMatchObject({ status: 'unavailable', reasons: expect.arrayContaining(['entity_unavailable']) });
    expect(result.currentRows[0]!.observation).not.toBeNull();
    expect(result.currentRows.slice(1).map((row) => row.observation)).toEqual([null, null]);
    expect(result.preview).toEqual(preview);
  });
  it.each(['target bid', 'campaign'] as const)('%s ordinary sync survives coordinated promotion, changes, deletion and stale reads', async (kind) => {
    const { PostgresWorkerStore } = await import('../store.js');
    const { CampaignRow, TargetRow } = await import('@wizard-ads/shared');
    const store = new PostgresWorkerStore(database, { info: () => {} });
    const profile = await store.profile(profileId);
    const stale = await store.beginEntityRead();
    expect(stale).toBeDefined();
    await drain('succeeded');
    const entityType = kind === 'target bid' ? 'target' : 'campaign';
    const [listed] = entityType === 'target'
      ? await database.sql<{ artifact: unknown }[]>`select jsonb_build_object(
        'entityType','target','profileId',profile_id,'amazonId',amazon_id,'adProduct',ad_product,'name',name,'state',state,
        'campaignId',campaign_id,'adGroupId',ad_group_id,'expression',expression,'resolvedExpression',resolved_expression,'bid',bid)
        as artifact from public.targets where profile_id=${profileId} and amazon_id='tg-1'`
      : await database.sql<{ artifact: unknown }[]>`select jsonb_build_object(
        'entityType','campaign','profileId',profile_id,'amazonId',amazon_id,'adProduct',ad_product,'name',name,'state',state,
        'portfolioId',portfolio_amazon_id,'budgetAmount',budget_amount,'budgetType',budget_type,'targetingType',targeting_type,
        'biddingStrategy',bidding_strategy,'placementBidding',placement_bidding,'startDate',start_date,'endDate',end_date)
        as artifact from public.campaigns where profile_id=${profileId} and amazon_id='c-1'`;
    const row = entityType === 'target' ? TargetRow.parse(listed!.artifact) : CampaignRow.parse(listed!.artifact);
    const state = async () => {
      const [current] = await database.sql.unsafe<{ snapshot: unknown }[]>(`select to_jsonb(t) as snapshot
        from public.${entityType === 'target' ? 'targets' : 'campaigns'} t where profile_id=$1::uuid and amazon_id=$2`,
      [profileId, row.amazonId]);
      return current!.snapshot;
    };
    const excludedEntityTypes = (['portfolio', 'campaign', 'ad_group', 'product_ad', 'keyword', 'target', 'negative'] as const)
      .filter((value) => value !== entityType);
    const merge = async (rows: typeof row[], readStartedAt: string, full = false) => store.syncEntities(profile, rows,
      { adProduct: 'SP', excludedEntityTypes, readStartedAt, full });
    const promoted = await state();
    const changed = row.entityType === 'target' ? { ...row, bid: 0.4 }
      : { ...row, placementBidding: { ...row.placementBidding!, topOfSearch: 200 } };
    expect(await merge([changed], stale!)).toMatchObject({ changes: 0,
      controlMirrors: { [entityType]: { listed: 1, upserted: 1, staleControlInputs: 1 } } });
    expect(await merge([], stale!, true)).toMatchObject({ changes: 0,
      controlMirrors: { [entityType]: { tombstoned: 0, staleTombstones: 1 } } });
    expect(await state()).toEqual(promoted);
    expect(await merge([row], (await store.beginEntityRead())!)).toMatchObject({ changes: 0,
      controlMirrors: { [entityType]: { listed: 1, upserted: 1, currentControlInputs: 1 } } });
    if (entityType === 'campaign') expect(await state()).toMatchObject({
      bidding_control_state: expect.objectContaining({ placements: expect.objectContaining({ topOfSearch: 300 }) }) });
    expect(await merge([changed], (await store.beginEntityRead())!)).toMatchObject({ changes: 1,
      controlMirrors: { [entityType]: { listed: 1, upserted: 1, currentControlInputs: 1 } } });
    if (entityType === 'campaign') expect(await state()).toMatchObject({ bidding_control_state: null });
    expect(await merge([], (await store.beginEntityRead())!, true)).toMatchObject({ changes: 1,
      controlMirrors: { [entityType]: { tombstoned: 1, staleTombstones: 0 } } });
    const tombstone = await state();
    expect(tombstone).not.toMatchObject({ deleted_at: null });
    expect(await merge([row], stale!)).toMatchObject({ changes: 0 });
    expect(await state()).toEqual(tombstone);
  });

});

