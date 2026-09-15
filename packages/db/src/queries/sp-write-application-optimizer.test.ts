import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SpWriteObservation, SpWritePredispatchObservation, SpWriteProviderCallIntent, SpWriteProviderResult,
  serializeSpWriteObservationFingerprint, serializeSpWritePredispatchObservationFingerprint,
  serializeSpWriteProviderCallIntentFingerprint, serializeSpWriteProviderRequestFingerprint,
  serializeSpWriteProviderResultFingerprint, type SpWriteAuthorizationReceipt, type SpWritePlan } from '@wizard-ads/shared/sp-writes';
import { spWriteConfirmation, type SpWritePreview, type SpWriteConfirmedApprovalRequest } from '@wizard-ads/shared/sp-write-application';
import { asServiceRole } from '../testing/rls.js';
import { createTestDatabase, type TestDatabase } from '../testing/harness.js';
import { syntheticRecommendationMethodInputs } from '../testing/recommendation-method.js';
import { withAuthenticatedOrgEditor, withAuthenticatedReadSnapshot } from './authenticated-actor.js';
import { previewSpWriteForActor, approveSpWriteForActor, readRecordedSpWritePreviewForActor } from './sp-write-commands.js';
import { prepareOptimizerRetry } from './sp-write-application-optimizer.js';
import { readOptimizerOperation } from './optimizer-run.js';
import { exportAcceptedRecommendations } from './recommendations.js';
import { createSpWriteOutboxLedger, createSpWriteRuntimeLedger } from './sp-write-persistence.js';
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const ZERO = '0'.repeat(64);
async function execute(
  database: TestDatabase, plan: SpWritePlan, receipt: SpWriteAuthorizationReceipt,
  outcomes: Array<'accepted' | 'authoritative_rejected' | 'ambiguous'>, refuseBeforeDispatch = false, onlyActionIds?: readonly string[],
) {
  // The provider protocol caps one call at 100 positions. Larger plans are the
  // production worker's chunking responsibility, outside this fixture helper.
  if (plan.actions.length < 1 || plan.actions.length > 100) throw new Error('synthetic execution requires 1 to 100 keyword bids');
  const actions = plan.actions.filter((action) => onlyActionIds === undefined || onlyActionIds.includes(action.actionId)).map((action) => {
    if (action.routeKey !== 'sp.v3.keywords.update' || action.changes.bid === undefined
      || Object.keys(action.changes).length !== 1) throw new Error('synthetic execution requires only keyword bid changes');
    return { ...action, bid: action.changes.bid };
  }).sort((left, right) => {
    // Provider observations use binary entity/action order independently of the
    // immutable plan's source sequence, just like the real provider codec.
    const a = `${left.entity.keywordId}:${left.actionId}`;
    const b = `${right.entity.keywordId}:${right.actionId}`;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const routeKey = 'sp.v3.keywords.update' as const;
  assert.equal(plan.counts.providerRows, plan.actions.length);
  assert.equal(actions.length, onlyActionIds?.length ?? plan.counts.providerRows);
  const runtime = createSpWriteRuntimeLedger(database);
  const outbox = createSpWriteOutboxLedger(database);
  const batch = await outbox.claimAvailable({ claimantId: 'synthetic-application-test', kinds: ['dispatch'], limit: 10 });
  assert.equal(batch.claimedCount, batch.claims.length);
  const claim = batch.claims.find((item) => item.planId === plan.id);
  for (const item of batch.claims) {
    if (item !== claim) assert.equal((await outbox.deferClaim(item, 'shutdown')).kind, 'deferred');
  }
  if (claim?.kind !== 'dispatch') throw new Error('synthetic dispatch missing');
  const lease = await runtime.acquireDispatchLease({ claim, routeKey });
  if (lease.kind !== 'acquired') throw new Error('synthetic lease missing');
  const [clock] = await database.sql<{ now: string; until: string }[]>`
    select app.sp_write_instant(clock_timestamp()) as now,
      app.sp_write_instant(clock_timestamp() + interval '60 seconds') as until
  `;
  if (clock === undefined) throw new Error('synthetic clock missing');
  const identity = { planId: plan.id, planFingerprint: plan.fingerprint, approvalId: receipt.approvalId,
    executionId: receipt.executionId, generation: receipt.generation };
  const observedActions = actions.map((action) => ({ routeKey, actionId: action.actionId, actionFingerprint: action.fingerprint,
    amazonEntityId: action.entity.keywordId, values: { bid: action.bid.expected } }));
  const observationBase = SpWritePredispatchObservation.parse({ ...identity,
    schemaVersion: 'openspell.sp-write-predispatch-observation.v1', observationId: randomUUID(),
    routeKey, observedAt: clock.now, validUntil: clock.until, items: observedActions, fingerprint: ZERO,
  });
  const observation = { ...observationBase, fingerprint: digest(serializeSpWritePredispatchObservationFingerprint(observationBase)) };
  const base = SpWriteProviderCallIntent.parse({ ...identity,
    schemaVersion: 'openspell.sp-write-provider-call-intent.v1', intentId: randomUUID(), providerCallId: randomUUID(),
    routeKey, attemptNumber: 1, dispatchLeaseId: lease.leaseId,
    providerObservationFingerprint: observation.fingerprint, requestFingerprint: ZERO, recordedAt: clock.now,
    positions: actions.map((action, requestIndex) => ({ requestIndex, actionId: action.actionId, actionFingerprint: action.fingerprint,
      amazonEntityId: action.entity.keywordId, actionRequestFingerprint: digest(JSON.stringify(action.changes)) })), fingerprint: ZERO,
  });
  base.requestFingerprint = digest(serializeSpWriteProviderRequestFingerprint(base));
  const intent = { ...base, fingerprint: digest(serializeSpWriteProviderCallIntentFingerprint(base)) };
  if (refuseBeforeDispatch) {
    const [previous] = await database.sql<{ version_id: string }[]>`select version_id from public.sp_write_environment_gate_head where singleton`;
    const closed = randomUUID();
    await database.sql`insert into public.sp_write_environment_gate_versions(version_id,enabled,max_unresolved_calls) values(${closed},false,1)`;
    await database.sql`update public.sp_write_environment_gate_head set version_id=${closed} where singleton`;
    try {
      expect(await runtime.reserveProviderCall({ claim, intent, observation })).toMatchObject({ kind: 'closed_without_dispatch', reason: 'environment_gate_closed' });
      expect((await outbox.completeClaim(claim)).kind).toBe('completed');
    } finally { await database.sql`update public.sp_write_environment_gate_head set version_id=${previous!.version_id} where singleton`; }
    return { observe: async () => { throw new Error('A refused action has no provider observation'); } };
  }
  const reservation = await runtime.reserveProviderCall({ claim, intent, observation });
  if (reservation.kind !== 'dispatch_once') throw new Error(`synthetic reservation failed: ${reservation.kind}`);
  const ticket = reservation.ticket;
  assert.equal((await outbox.completeClaim(claim)).kind, onlyActionIds ? 'not_complete' : 'completed');
  const [time] = await database.sql<{ now: string }[]>`select app.sp_write_instant(clock_timestamp()) as now`;
  const result = SpWriteProviderResult.parse({
    schemaVersion: 'openspell.sp-write-provider-result.v1', resultId: ticket.resultId, intentId: intent.intentId,
    intentFingerprint: intent.fingerprint, providerCallId: intent.providerCallId, requestFingerprint: intent.requestFingerprint,
    completedAt: time!.now, positions: actions.map((action, requestIndex) => ({ requestIndex, actionId: action.actionId,
      actionFingerprint: action.fingerprint, actionRequestFingerprint: intent.positions[requestIndex]!.actionRequestFingerprint,
      outcome: outcomes[requestIndex], providerEntityId: outcomes[requestIndex] !== 'ambiguous' ? action.entity.keywordId : null,
      code: null, message: null })), fingerprint: ZERO,
  });
  result.fingerprint = digest(serializeSpWriteProviderResultFingerprint(result));
  assert.equal(await runtime.appendProviderResult(result), 'recorded');
  assert.equal(await runtime.appendProviderResult(result), 'already_recorded');
  if (onlyActionIds) assert.equal((await outbox.deferClaim(claim, 'shutdown')).kind, 'deferred');
  const recordedPositions = await database.sql<{ request_index: number; action_id: string; outcome: string }[]>`
    select request_index, action_id, outcome::text from public.sp_write_provider_result_positions
    where org_id = ${plan.orgId} and profile_id = ${plan.profileId} and result_id = ${result.resultId}
    order by request_index
  `;
  assert.deepEqual([...recordedPositions], actions.map((action, request_index) => ({ request_index, action_id: action.actionId, outcome: outcomes[request_index] })));
  return { observe: async (outcome: 'observed_requested' | 'observed_expected_after_ambiguous' | 'conflict') => {
    let observer;
    for (let pass = 0; pass < 10 && !observer; pass += 1) {
      const observers = await outbox.claimAvailable({ claimantId: 'synthetic-retry-observer', kinds: ['observe_and_recover'], limit: 10 });
      expect(observers.claimedCount).toBe(observers.claims.length);
      observer = observers.claims.find((item) => item.planId === plan.id && item.intentId === intent.intentId);
      for (const other of observers.claims) if (other !== observer) await outbox.deferClaim(other, 'shutdown');
    }
    if (observer?.kind !== 'observe_and_recover') throw new Error('Missing synthetic observation');
    for (const [index, action] of actions.entries()) {
      if (outcomes[index] === 'authoritative_rejected') continue;
      const [after] = await database.sql<{ now: string }[]>`select app.sp_write_instant(clock_timestamp()) as now`;
      const observed = SpWriteObservation.parse({ ...identity,
        schemaVersion: 'openspell.sp-write-observation.v1', observationId: randomUUID(), intentId: intent.intentId,
        intentFingerprint: intent.fingerprint, providerCallId: intent.providerCallId, requestFingerprint: intent.requestFingerprint,
        actionId: action.actionId, actionFingerprint: action.fingerprint, routeKey,
        sourceSyncJobId: observer.sourceSyncJobId, observedAt: after!.now, outcome,
        observed: { ...observedActions[index]!, values: { bid: outcome === 'observed_requested' ? action.bid.requested : action.bid.expected } }, fingerprint: ZERO });
      observed.fingerprint = digest(serializeSpWriteObservationFingerprint(observed));
      expect(await runtime.appendObservation(observed)).toBe(observed.observationId);
    }
    expect((await outbox.completeClaim(observer)).kind).toBe('completed');
  } };
}

describe('forward source narrowing and immutable retry lineage', () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase('optimizer_retry');
    const version = randomUUID();
    await db.sql`insert into public.sp_write_environment_gate_versions(version_id,enabled,max_unresolved_calls) values(${version},true,1)`;
    await db.sql`insert into public.sp_write_environment_gate_head(singleton,version_id) values(true,${version})`;
  }, 60_000);
  afterAll(async () => { await db?.drop(); });
  async function fixture(unnamedSuccess = false) {
    const userId = randomUUID();
    const [org] = await db.sql<{ id: string }[]>`select app.seed_tenant_fixture(${randomUUID()},${userId},'owner') as id`;
    const actor = { orgId: org!.id, userId };
    const [profile] = await db.sql<{ id: string }[]>`select id from public.ad_profiles where org_id=${actor.orgId}`;
    const profileId = profile!.id;
    const [run] = await db.sql<{ id: string; batch_id: string }[]>`select id,batch_id from public.recommendation_runs where org_id=${actor.orgId}`;
    const version = randomUUID();
    await db.sql`insert into public.sp_write_profile_grant_versions(grant_id,version_id,org_id,profile_id,enabled,amazon_profile_id,connection_id,region,marketplace_id,currency_code,api_dialect,created_by)
      select grant_id,${version},org_id,profile_id,true,amazon_profile_id,connection_id,region,marketplace_id,currency_code,api_dialect,created_by
      from public.sp_write_profile_grant_versions where org_id=${actor.orgId} and profile_id=${profileId}`;
    await db.sql`update public.sp_write_profile_grant_heads set version_id=${version} where org_id=${actor.orgId} and profile_id=${profileId}`;
    const ids = [randomUUID(),randomUUID()];
    for (const [i,id] of ids.entries()) {
      await db.sql`insert into public.keywords(org_id,profile_id,amazon_id,ad_product,name,state,campaign_id,ad_group_id,keyword_text,match_type,bid)
        values(${actor.orgId},${profileId},${`synthetic-retry-${i}`},'SP',${`Synthetic retry target ${i}`},'enabled','c-1','ag-1','synthetic','exact',0.91)`;
      await db.sql`insert into public.recommendations(id,run_id,org_id,profile_id,reason,entity_type,entity_id,entity_name,campaign_id,ad_group_id,ad_product,field,current_value,proposed_value,inputs,status)
        values(${id},${run!.id},${actor.orgId},${profileId},'high_acos','keyword',${`synthetic-retry-${i}`},${unnamedSuccess && i === 0 ? null : `Synthetic retry target ${i}`},'c-1','ag-1','SP','bid','0.91'::jsonb,'0.67'::jsonb, ${JSON.stringify(syntheticRecommendationMethodInputs())}::jsonb,'accepted')`;
    }
    const source = await exportAcceptedRecommendations(db, { orgId: actor.orgId, profileId, runId: run!.id, ids,
      tag: randomUUID(), optGroup: 'synthetic', lever: 'bid', note: 'Synthetic retry proof', actorId: userId });
    const request = { requestId: randomUUID(), profileId, applyBatchId: source.batchId };
    const preview = await withAuthenticatedOrgEditor(db, actor, (tx) => previewSpWriteForActor(tx, request));
    const confirm = (plan: SpWritePreview, requestId = randomUUID()): SpWriteConfirmedApprovalRequest => ({ profileId,
      confirmation: spWriteConfirmation(plan.plan.counts.logicalChanges), approval: { approvalRequestId: requestId,
        plan: plan.binding, approvalMode: 'manual', confirmationVersion: 'openspell.amazon-sp-write-confirmation.v1',
        boundedAuthorization: null, preapprovedInversePlan: null } });
    const approve = (plan: SpWritePreview) => withAuthenticatedOrgEditor(db, actor, (tx) => approveSpWriteForActor(tx, confirm(plan)));
    const read = (operation: { executionId: string; planId: string }) => withAuthenticatedReadSnapshot(db, actor, (tx) => readOptimizerOperation(tx, { profileId, ...operation }));
    const retry = (original: { executionId: string; planId: string }, requestId = randomUUID()) => withAuthenticatedOrgEditor(db, actor,
      (tx) => prepareOptimizerRetry(tx, { requestId, profileId, batchId: run!.batch_id, original }));
    return { actor, profileId, batchId: run!.batch_id, request, preview, confirm, approve, read, retry };
  }
  const rows = (preview: SpWritePreview) => preview.plan.actions.flatMap((a) => a.sources.flatMap((s) => s.kind === 'apply_row' ? [s.applyRowId] : []));
  it('narrows only after verifying the complete original artifact and retains every original identity', async () => {
    const f = await fixture(); const selected = [rows(f.preview)[1]!];
    const narrowed = await withAuthenticatedOrgEditor(db, f.actor, (tx) => previewSpWriteForActor(tx, { ...f.request, requestId: randomUUID(), forwardRowIds: selected }));
    expect(rows(narrowed)).toEqual(selected);
    expect(narrowed.plan.actions[0]?.sources).toEqual(f.preview.plan.actions[1]?.sources);
    expect(narrowed.plan.actions[0]?.entity).toEqual(f.preview.plan.actions[1]?.entity);
    expect(narrowed.plan.actions[0]?.changes).toEqual(f.preview.plan.actions[1]?.changes);
    expect(narrowed.plan.source).toMatchObject({ forwardRowIds: selected, sourceArtifactText: f.preview.evidence?.provenance.artifactText });
    await db.sql`update public.apply_rows set entity_name='Tampered excluded name' where id=${rows(f.preview)[0]!}`;
    await expect(withAuthenticatedOrgEditor(db, f.actor, (tx) => previewSpWriteForActor(tx,
      { ...f.request, requestId: randomUUID(), forwardRowIds: selected }))).rejects.toMatchObject({ code: 'source_changed' });
    const recorded = await withAuthenticatedReadSnapshot(db, f.actor, (tx) => readRecordedSpWritePreviewForActor(tx, { profileId: f.profileId, planId: narrowed.plan.id }));
    expect(recorded.freshness.reasons).toContain('source_changed');
    await expect(f.approve(narrowed)).rejects.toThrow();
  });
  it('retries only original authoritative rejections and names successful rows from saved evidence', async () => {
    const f = await fixture(); const admitted = await f.approve(f.preview); const before = await f.read(admitted.operation);
    await execute(db, f.preview.plan, before.detail.receipt, ['accepted','authoritative_rejected']);
    const parent = await f.read(admitted.operation);
    expect(parent.detail.snapshot.accounting).toMatchObject({ approvedRows: 2, intentCommitted: 2, providerAccepted: 1, providerRejected: 1, observedRequested: 0 });
    const retryId = randomUUID(); const retry = await f.retry(admitted.operation, retryId);
    expect(retry.preview.plan.counts.logicalChanges).toBe(1);
    expect(retry.preview.plan.actions[0]?.entity).toEqual({ keywordId: 'synthetic-retry-1' });
    expect(rows(retry.preview)).toEqual(parent.rows.filter((r) => r.retryEligible).flatMap((r) => r.applyRowIds));
    expect(retry.excludedSuccessfulRows).toEqual([{ applyRowId: parent.rows.find((r) => r.status === 'accepted')!.applyRowIds[0], name: 'Synthetic retry target 0' }]);
    expect(await f.retry(admitted.operation, retryId)).toEqual(retry);
    await expect(withAuthenticatedOrgEditor(db,f.actor,(tx) => previewSpWriteForActor(tx, { ...f.request,requestId:retryId,
      forwardRowIds:rows(retry.preview).sort(),retryOrigin:{...admitted.operation,planFingerprint:'a'.repeat(64)} }))).rejects.toMatchObject({code:'identity_conflict'});
    const req = f.confirm(retry.preview);
    expect(req.confirmation).toBe('Yes, apply 1 changes to Amazon');
    const approve = () => withAuthenticatedOrgEditor(db, f.actor, (tx) => approveSpWriteForActor(tx, req));
    const saved = await approve();
    await expect(approve().then(() => { throw new Error('Lost approval response'); })).rejects.toThrow('Lost approval response');
    expect(await approve()).toEqual(saved);
    const child = await f.read(saved.operation);
    expect(child.detail.snapshot.accounting).toMatchObject({ approvedRows: 1, pendingDispatch: 1, intentCommitted: 0 });
    expect((await f.read(admitted.operation)).detail.snapshot.accounting).toEqual(parent.detail.snapshot.accounting);
    await db.sql`update public.apply_rows set entity_name='Changed display name' where id=${retry.excludedSuccessfulRows[0]!.applyRowId}`;
    expect((await f.retry(admitted.operation,retryId)).excludedSuccessfulRows).toEqual(retry.excludedSuccessfulRows);
  });
  it('names an unnamed excluded success using its immutable exported entity identity', async () => {
    const f = await fixture(true); const root = await f.approve(f.preview); const original = await f.read(root.operation);
    await execute(db,f.preview.plan,original.detail.receipt,['accepted','authoritative_rejected']);
    await db.sql`update public.recommendations rec set status='applied' from public.apply_rows r
      where r.id=${rows(f.preview)[0]!} and rec.id=r.recommendation_id and rec.org_id=r.org_id`;
    const retry = await f.retry(root.operation);
    expect(retry.excludedSuccessfulRows).toEqual([{ applyRowId: rows(f.preview)[0], name: 'synthetic-retry-0' }]);
    expect(retry.preview.plan.counts.logicalChanges).toBe(1);
  });
  it('admits exactly one concurrent successor and requires later retries to descend from the latest failed operation', async () => {
    const f = await fixture(); const root = await f.approve(f.preview); const original = await f.read(root.operation);
    await execute(db,f.preview.plan,original.detail.receipt,['accepted','authoritative_rejected']);
    const [a,b] = await Promise.all([f.retry(root.operation),f.retry(root.operation)]);
    const outcomes = await Promise.allSettled([f.approve(a.preview),f.approve(b.preview)]);
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const winnerIndex = outcomes.findIndex((r) => r.status === 'fulfilled');
    const winner = outcomes[winnerIndex]; if (winner?.status !== 'fulfilled') throw new Error('No admitted successor');
    const plan = [a,b][winnerIndex]!.preview;
    const loser = [a,b][1-winnerIndex]!.preview;
    const stale = await withAuthenticatedReadSnapshot(db,f.actor,(tx) => readRecordedSpWritePreviewForActor(tx,{profileId:f.profileId,planId:loser.plan.id}));
    expect(stale.freshness.reasons).toContain('source_changed');
    await expect(f.retry(root.operation)).rejects.toThrow();
    const child = await f.read(winner.value.operation);
    await execute(db,plan.plan,child.detail.receipt,['authoritative_rejected']);
    const next = await f.retry(winner.value.operation);
    expect(next.preview.plan.source).toMatchObject({ retryOrigin: { ...winner.value.operation, planFingerprint: plan.plan.fingerprint } });
    expect(rows(next.preview)).toEqual(rows(plan));
    await expect(f.retry(root.operation)).rejects.toThrow();
    await f.approve(next.preview);
    const claims = await db.sql`select parent_plan_id,source_row_id from app.sp_write_forward_admissions where org_id=${f.actor.orgId}`;
    expect(claims).toHaveLength(4); // two root rows, one child and one grandchild
  });
  it('refuses successful source reuse through alternate ids, origin spoofing and source UUID replacement', async () => {
    const f = await fixture(); const staged = await withAuthenticatedOrgEditor(db,f.actor,(tx) => previewSpWriteForActor(tx,{...f.request,requestId:randomUUID()}));
    const root = await f.approve(f.preview); const detail = await f.read(root.operation);
    await execute(db,f.preview.plan,detail.detail.receipt,['accepted','authoritative_rejected']);
    await expect(f.approve(staged)).rejects.toThrow();
    await expect(withAuthenticatedOrgEditor(db,f.actor,(tx) => previewSpWriteForActor(tx,{...f.request,requestId:randomUUID(),forwardRowIds:[rows(f.preview)[0]!]}))).rejects.toThrow();
    await expect(db.sql`update public.apply_rows set id=${randomUUID()} where id=${rows(f.preview)[0]!}`).rejects.toThrow('identity');
    await expect(withAuthenticatedOrgEditor(db,f.actor,(tx) => previewSpWriteForActor(tx,{...f.request,requestId:randomUUID(),forwardRowIds:rows(f.preview).sort(),retryOrigin:{...root.operation,planFingerprint:f.preview.plan.fingerprint}}))).rejects.toThrow();
    await expect(f.retry({ ...root.operation, executionId:randomUUID() })).rejects.toThrow();
    await expect(withAuthenticatedOrgEditor(db,f.actor,(tx) => tx.sql`insert into app.sp_write_forward_lineage(org_id) values(${f.actor.orgId})`)).rejects.toMatchObject({code:'42501'});
  });
  it('keeps private lineage tenant-closed, immutable and purgeable only through its organization', async () => {
    const f=await fixture(); const g=await fixture();
    for (const item of [f,g]) {
      const root=await item.approve(item.preview); const detail=await item.read(root.operation);
      await execute(db,item.preview.plan,detail.detail.receipt,['accepted','authoritative_rejected']);
      const retry=await item.retry(root.operation); await item.approve(retry.preview);
    }
    const own=await withAuthenticatedReadSnapshot(db,f.actor,(tx) => tx.sql`select
      (select count(*)::int from app.sp_write_forward_lineage) as lineage,
      (select count(*)::int from app.sp_write_forward_admissions) as claims`);
    expect(own).toEqual([{lineage:1,claims:3}]);
    expect(await withAuthenticatedReadSnapshot(db,f.actor,(tx) => tx.sql`select retry_plan_id from app.sp_write_forward_lineage where org_id=${g.actor.orgId}`)).toEqual([]);
    await asServiceRole(db,async (sql) => {
      await expect(sql`delete from app.sp_write_forward_lineage where org_id=${f.actor.orgId}`).rejects.toMatchObject({code:'42501'});
      await expect(sql`update app.sp_write_forward_admissions set parent_plan_id=null where org_id=${f.actor.orgId}`).rejects.toMatchObject({code:'42501'});
    });
    await expect(db.sql`delete from app.sp_write_forward_lineage where org_id=${f.actor.orgId}`).rejects.toThrow('immutable');
    await expect(db.sql`update app.sp_write_forward_admissions set parent_plan_id=null where org_id=${f.actor.orgId}`).rejects.toThrow('immutable');
    const keys=await db.sql<{definition:string}[]>`select pg_get_constraintdef(oid) as definition from pg_constraint
      where conrelid in ('app.sp_write_forward_lineage'::regclass,'app.sp_write_forward_admissions'::regclass) and contype='f'`;
    expect(keys.length).toBe(9);
    expect(keys.filter((k) => !k.definition.includes('FOREIGN KEY (org_id)')).every((k) => k.definition.includes('FOREIGN KEY (org_id, profile_id,'))).toBe(true);
    await db.sql`delete from public.orgs where id=${f.actor.orgId}`;
    expect(await db.sql`select (select count(*)::int from app.sp_write_forward_lineage where org_id=${f.actor.orgId}) as lineage,
      (select count(*)::int from app.sp_write_forward_admissions where org_id=${f.actor.orgId}) as claims`).toEqual([{lineage:0,claims:0}]);
    expect(await db.sql`select count(*)::int as count from app.sp_write_forward_lineage where org_id=${g.actor.orgId}`).toEqual([{count:1}]);
  });
  it('refuses changed synchronized bids until fresh linked evaluation, without rewriting original expected values', async () => {
    const f=await fixture(); const root=await f.approve(f.preview); const detail=await f.read(root.operation);
    await execute(db,f.preview.plan,detail.detail.receipt,['accepted','authoritative_rejected']);
    const ready=await f.retry(root.operation);
    await db.sql`update public.keywords set bid=0.95 where org_id=${f.actor.orgId} and amazon_id='synthetic-retry-1'`;
    await expect(f.retry(root.operation)).rejects.toThrow();
    await expect(f.approve(ready.preview)).rejects.toThrow();
    const saved=await withAuthenticatedReadSnapshot(db,f.actor,(tx) => readRecordedSpWritePreviewForActor(tx,{profileId:f.profileId,planId:ready.preview.plan.id}));
    expect(saved.freshness.reasons).toContain('current_value_changed');
    expect(saved.preview.plan.actions[0]?.changes).toEqual(ready.preview.plan.actions[0]?.changes);
    expect(saved.preview.plan.actions[0]?.changes).toMatchObject({ bid: { expected: { amount: '0.91' } } });
  });
  it('retries immutable refusal-before-dispatch evidence without inventing an attempted provider call', async () => {
    const f=await fixture(); const root=await f.approve(f.preview); const detail=await f.read(root.operation);
    await execute(db,f.preview.plan,detail.detail.receipt,[],true);
    const refused=await f.read(root.operation);
    expect(refused.detail.snapshot.accounting).toMatchObject({ approvedRows:2,refusedBeforeDispatch:2,pendingDispatch:0,intentCommitted:0,providerCallsCommitted:0 });
    expect(refused.rows.every((r) => r.retryEligible && r.status==='refused')).toBe(true);
    const retry=await f.retry(root.operation);
    expect(rows(retry.preview).sort()).toEqual(rows(f.preview).sort());
    expect(retry.excludedSuccessfulRows).toEqual([]);
    expect(retry.preview.plan.counts.logicalChanges).toBe(2);
    await f.approve(retry.preview);
  });
  it('waits for terminal sibling outcomes so a later failure cannot be stranded behind a retry branch', async () => {
    const f=await fixture(); const root=await f.approve(f.preview); const detail=await f.read(root.operation);
    await execute(db,f.preview.plan,detail.detail.receipt,['authoritative_rejected'],false,[f.preview.plan.actions[0]!.actionId]);
    const parent=await f.read(root.operation);
    expect(parent.detail.snapshot.accounting).toMatchObject({approvedRows:2,pendingDispatch:1,intentCommitted:1,providerRejected:1});
    expect(parent.rows.map((row) => row.status)).toEqual(['failed','pending']);
    expect(parent.rows.every((row) => !row.retryEligible)).toBe(true);
    await expect(f.retry(root.operation)).rejects.toThrow();
    expect(await db.sql`select retry_plan_id from app.sp_write_forward_lineage where org_id=${f.actor.orgId}`).toEqual([]);
  });
  it('excludes pending sends and expected-value observations after ambiguity, and keeps accepted distinct from observed', async () => {
    const f=await fixture(); const root=await f.approve(f.preview);
    await expect(f.retry(root.operation)).rejects.toThrow();
    const detail=await f.read(root.operation);
    const sent=await execute(db,f.preview.plan,detail.detail.receipt,['ambiguous','ambiguous']);
    await expect(f.retry(root.operation)).rejects.toThrow();
    await sent.observe('observed_expected_after_ambiguous');
    const ambiguous=await f.read(root.operation);
    expect(ambiguous.rows.every((r) => !r.retryEligible && r.status==='ambiguous')).toBe(true);
    expect(ambiguous.detail.snapshot.accounting).toMatchObject({providerAmbiguous:2,observedExpectedAfterAmbiguous:2,observedRequested:0});
    await expect(f.retry(root.operation)).rejects.toThrow();
    const g=await fixture(); const accepted=await g.approve(g.preview); const d=await g.read(accepted.operation);
    const pending=await execute(db,g.preview.plan,d.detail.receipt,['accepted','authoritative_rejected']);
    expect((await g.read(accepted.operation)).detail.snapshot.accounting.observedRequested).toBe(0);
    await pending.observe('observed_requested');
    const observed=await g.read(accepted.operation);
    expect(observed.detail.snapshot.accounting).toMatchObject({providerAccepted:1,observedRequested:1});
    const retry=await g.retry(accepted.operation);
    expect(retry.excludedSuccessfulRows).toHaveLength(1);
    expect(retry.preview.plan.counts.logicalChanges).toBe(1);
  });
});
