import { randomUUID, createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CampaignBuilderCheck, CampaignBuilderRecipe, CampaignCreationProviderResult, campaignCreationBatchSummary, campaignCreationRetrySelection, type CampaignCreationBatchObservation, type CampaignCreationBatch, type CampaignDraft, type CampaignCreationBatchRequest,
  type CampaignCreationAdmissionValidation } from '@wizard-ads/shared';
import { buildCampaignRecipe, campaignRecipeCreationPlan } from '@wizard-ads/campaigns';
import { bindSponsoredProductsCreationPlan } from '@wizard-ads/shared';
import { createTestDatabase, type TestDatabase } from '../testing/harness.js';
import { asUser } from '../testing/rls.js';
import { withAuthenticatedOrgEditor, withAuthenticatedReadSnapshot } from './authenticated-actor.js';
import { saveCampaignDraft, recordCampaignDraftValidation, readCampaignDraft } from './campaign-drafts.js';
import { admitCampaignCreation, readCampaignCreationBatch, readCampaignCreationGate, findCampaignCreationAdmission } from './campaign-creation-batches.js';
import { createCampaignCreationLedger } from './campaign-creation-worker.js';
import { countChangeQueue, listChangeQueue } from './time-machine.js';

describe('creation batch SQL authority and accounting', () => {
  let db: TestDatabase; let profileId: string; let connectionId: string;
  const actor = { userId: randomUUID(), orgId: '' }; const other = { userId: randomUUID(), orgId: '' };
  const gateId = randomUUID(); const grantId = randomUUID(); const grantVersion = randomUUID();
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');
  beforeEach(async () => {
    db = await createTestDatabase('creation290');
    for (const [index, current] of [actor, other].entries()) {
      const [row] = await db.sql<{ id: string }[]>`select app.seed_tenant_fixture(${'creation-synthetic-' + index},${current.userId},'owner') as id`;
      current.orgId = row!.id;
    }
    const [profile] = await db.sql<{ id: string; connection_id: string }[]>`select id,connection_id from public.ad_profiles where org_id=${actor.orgId} limit 1`;
    profileId = profile!.id; connectionId = profile!.connection_id;
    await db.sql`update public.ad_profiles set amazon_profile_id='900000000001',account_type='seller' where id=${profileId}`;
    await db.sql`update public.product_ads set asin='B000000001',sku='SYNTHETIC-SKU' where org_id=${actor.orgId} and profile_id=${profileId}`;
    await db.sql`insert into public.sp_write_environment_gate_versions(version_id,enabled,max_unresolved_calls) values(${gateId},true,1)`;
    await db.sql`insert into public.sp_write_environment_gate_head(singleton,version_id) values(true,${gateId}) on conflict(singleton) do update set version_id=excluded.version_id`;
    await db.sql`insert into public.sp_write_profile_grant_versions(grant_id,version_id,org_id,profile_id,enabled,amazon_profile_id,connection_id,region,marketplace_id,currency_code,api_dialect)
      values(${grantId},${grantVersion},${actor.orgId},${profileId},true,'900000000001',${connectionId},'NA','ATVPDKIKX0DER','USD','sp_v3')`;
    await db.sql`insert into public.sp_write_profile_grant_heads(org_id,profile_id,grant_id,version_id) values(${actor.orgId},${profileId},${grantId},${grantVersion})
      on conflict(org_id,profile_id) do update set grant_id=excluded.grant_id,version_id=excluded.version_id`;
  }, 120_000);
  afterEach(async () => { await db?.drop(); });

  async function draft(validated = true) {
    const now = Date.now();
    const recipe = CampaignBuilderRecipe.parse({ adType: 'SP', productKeys: ['synthetic-product'], play: 'rank', groupId: randomUUID(), dailyBudget: 20,
      keywords: [{ text: 'synthetic keyword', bid: 1.25, basis: 'manual' }], structure: 'keyword-product', topOfSearch: 25, audienceAdjustment: 0,
      naming: { variable_order: ['Goal', 'AdType', 'MatchType', 'Keyword'], delimiter: ' / ', custom1_value: '' }, names: { '0': `Synthetic campaign ${randomUUID()}` } });
    const frozen = bindSponsoredProductsCreationPlan(campaignRecipeCreationPlan(buildCampaignRecipe(recipe, { profile: { id: profileId, label: 'Synthetic profile', countryCode: 'US', currencyCode: 'USD', marketplace: null }, products: [{ key: 'synthetic-product', asin: 'B000000001', sku: 'SYNTHETIC-SKU', name: 'Synthetic product', state: 'enabled', observedAt: null }], today: new Date(now).toISOString().slice(0,10) }), { orgId: actor.orgId, profileId, marketplaceId: 'ATVPDKIKX0DER', currencyCode: 'USD', now: new Date(now-1000).toISOString(), expiresAt: new Date(now+3600_000).toISOString(), uuid: randomUUID, hasher: { algorithm: 'sha256', digest: sha } }), { amazonProfileId: '900000000001', connectionId, region: 'NA', marketplaceId: 'ATVPDKIKX0DER', currencyCode: 'USD', accountType: 'seller' }, { algorithm: 'sha256', digest: sha });
    let saved = await withAuthenticatedOrgEditor(db, actor, (tx) => saveCampaignDraft(tx, { id: randomUUID(), expectedRevision: null, plan: frozen, recipe, rationale: [] }));
    const checks = CampaignBuilderCheck.shape.id.options.map((id) => ({ id, label: id, source: 'Synthetic measured fixture', status: 'passed' as const,
      blocking: false, currentValue: 'Synthetic value', requiredAction: '' }));
    const measured: CampaignCreationAdmissionValidation = { planFingerprint: frozen.fingerprint, recipeFingerprint: sha(JSON.stringify(saved.recipe)),
      checkedAt: new Date().toISOString(), checks };
    if (validated) saved = await withAuthenticatedOrgEditor(db, actor, (tx) => recordCampaignDraftValidation(tx, saved, { ...measured,
      checks: checks.map((check) => ['stock','buy-box','suppression','moderation'].includes(check.id) ? { ...check, status: 'not_measured' } : check) }));
    return { saved, measured };
  }
  const request = (saved: CampaignDraft): CampaignCreationBatchRequest => ({ action: 'create', profileId, draftId: saved.id,
    expectedRevision: saved.revision, planFingerprint: saved.plan.fingerprint });
  async function approve(saved: CampaignDraft, measured: CampaignCreationAdmissionValidation, changes: Record<string, unknown> = {}) {
    return withAuthenticatedOrgEditor(db, actor, (tx) => admitCampaignCreation(tx, { ...request(saved), ...changes } as CampaignCreationBatchRequest, measured));
  }
  it('admits exactly one four-node batch and repeats the same immutable approval', async () => {
    const { saved, measured } = await draft();
    const first = await approve(saved, measured); const repeated = await approve(saved, measured);
    expect(repeated).toEqual(first); expect(first.nodes).toHaveLength(4); expect(first.productChecks).toHaveLength(1);
    expect(await withAuthenticatedReadSnapshot(db, actor, (tx) => findCampaignCreationAdmission(tx, request(saved)))).toEqual(first);
    await expect(withAuthenticatedOrgEditor(db, actor, async (tx) => {
      const current = await readCampaignDraft(tx, profileId, saved.id);
      return recordCampaignDraftValidation(tx, current!, current!.validation!);
    })).rejects.toThrow('The draft changed');
    expect((await approve(saved, measured)).id).toBe(first.id);
    const [count] = await db.sql`select (select count(*)::int from public.campaign_creation_batches where draft_id=${saved.id}) as batches,
      (select count(*)::int from public.campaign_creation_batch_nodes where batch_id=${first.id}) as nodes,
      (select count(*)::int from public.campaign_creation_outbox where batch_id=${first.id}) as wakes`;
    expect(count).toEqual({ batches: 1, nodes: 4, wakes: 1 });
    expect(await withAuthenticatedReadSnapshot(db, other, (tx) => readCampaignCreationBatch(tx, profileId, first.id))).toBeNull();
    expect(await asUser(db, other.userId, (sql) => sql`select node_id from public.campaign_creation_batch_nodes where batch_id=${first.id}`)).toHaveLength(0);
    await expect(asUser(db, actor.userId, (sql) => sql`update public.campaign_creation_batch_nodes set refusal='gate_closed' where batch_id=${first.id}`)).rejects.toMatchObject({ code: '42501' });
  });
  it('refuses stale fingerprint, revision, unvalidated draft, blocking and unknown checks by code', async () => {
    const { saved, measured } = await draft();
    await expect(approve(saved, measured, { planFingerprint: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'stale_fingerprint' });
    await expect(approve(saved, measured, { expectedRevision: saved.revision + 1 })).rejects.toMatchObject({ code: 'stale_revision' });
    await expect(approve(saved, { ...measured, checks: measured.checks.map((row, i) => i ? row : { ...row, status: 'blocked', blocking: true }) })).rejects.toMatchObject({ code: 'blocking_check' });
    await expect(approve(saved, { ...measured, checks: measured.checks.map((row, i) => i ? row : { ...row, status: 'not_measured' }) })).rejects.toMatchObject({ code: 'freshness_not_current' });
    const unvalidated = await draft(false);
    await expect(approve(unvalidated.saved, unvalidated.measured)).rejects.toMatchObject({ code: 'draft_not_validated' });
    const [count] = await db.sql`select count(*)::int as batches from public.campaign_creation_batches where draft_id=${saved.id}`;
    expect(count?.batches).toBe(0);
  });
  it('rechecks environment and profile grant at admission', async () => {
    const { saved, measured } = await draft(); const closed = randomUUID();
    await db.sql`insert into public.sp_write_environment_gate_versions(version_id,enabled,max_unresolved_calls) values(${closed},false,1)`;
    await db.sql`update public.sp_write_environment_gate_head set version_id=${closed}`;
    await expect(approve(saved, measured)).rejects.toMatchObject({ code: 'environment_gate_off' });
    expect(await withAuthenticatedReadSnapshot(db, actor, (tx) => readCampaignCreationGate(tx, saved.plan))).toMatchObject({ available: false });
    await db.sql`update public.sp_write_environment_gate_head set version_id=${gateId}`;
    await db.sql`delete from public.sp_write_profile_grant_heads where org_id=${actor.orgId} and profile_id=${profileId}`;
    await expect(approve(saved, measured)).rejects.toMatchObject({ code: 'profile_not_allowlisted' });
    await db.sql`insert into public.sp_write_profile_grant_heads(org_id,profile_id,grant_id,version_id) values(${actor.orgId},${profileId},${grantId},${grantVersion})`;
  });
  it('reserves once under a claim and checks revoked authority before a new attempt', async () => {
    const { saved, measured } = await draft(); const batch = await approve(saved, measured);
    // Isolate this batch from earlier synthetic pending work.
    await db.sql`update public.campaign_creation_outbox set available_at=clock_timestamp()+interval '1 hour' where batch_id<>${batch.id}`;
    const ledger = createCampaignCreationLedger(db); const claim = await ledger.claim(randomUUID(), [profileId]);
    expect(claim?.batchId).toBe(batch.id);
    const node = batch.nodes[0]!; const intent = { id: randomUUID(), requestDigest: 'a'.repeat(64), nodeRequestDigest: 'b'.repeat(64), reservedAt: new Date().toISOString(), deadline: new Date(Date.now()+35_000).toISOString() };
    const first = await ledger.reserve(claim!, node.nodeId, intent);
    expect(first.kind).toBe('dispatch_once'); expect((await ledger.reserve(claim!, node.nodeId, intent)).kind).toBe('already_reserved');
    expect((await ledger.load(claim!)).nodes.filter((row) => row.intent !== null)).toHaveLength(1);
    await expect(db.sql`delete from public.orgs where id=${actor.orgId}`).rejects.toMatchObject({ code: '55000', message: 'Organization has unresolved campaign creation' });
    const [oldIntents] = await db.sql`select count(*)::int as count from public.sp_write_provider_call_intents`;
    expect(oldIntents!.count).toBeGreaterThan(0);
    await expect(db.sql`insert into public.sp_write_provider_call_intents select
      (jsonb_populate_record(null::public.sp_write_provider_call_intents,to_jsonb(i)||jsonb_build_object('intent_id',gen_random_uuid()))).*
      from public.sp_write_provider_call_intents i limit 1`).rejects.toMatchObject({ code: '55000', message: 'Campaign creation has an unresolved provider call' });
    const second = await draft(); const next = await approve(second.saved, second.measured);
    await db.sql`update public.campaign_creation_outbox set available_at=clock_timestamp()+interval '1 hour' where batch_id<>${next.id}`;
    const nextClaim = await ledger.claim(randomUUID(), [profileId]);
    expect((await ledger.reserve(nextClaim!, next.nodes[0]!.nodeId, intent)).kind).toBe('pending');
    expect((await ledger.load(nextClaim!)).nodes.filter((row) => row.intent !== null)).toHaveLength(0);
    await db.sql`delete from public.sp_write_profile_grant_heads where org_id=${actor.orgId} and profile_id=${profileId}`;
    expect((await ledger.reserve(nextClaim!, next.nodes[0]!.nodeId, intent)).kind).toBe('refused');
    expect((await ledger.load(nextClaim!)).nodes.filter((row) => row.refusal === 'gate_closed')).toHaveLength(4);
    await db.sql`insert into public.sp_write_profile_grant_heads(org_id,profile_id,grant_id,version_id) values(${actor.orgId},${profileId},${grantId},${grantVersion})`;
  });
  it('bounds authority by review freshness and refuses products removed before the first attempt',async()=>{
    const {saved,measured}=await draft();const batch=await approve(saved,measured);
    expect(Date.parse(batch.expiresAt)).toBe(Math.min(Date.parse(batch.plan.expiresAt),Date.parse(measured.checkedAt)+300_000));
    await db.sql`update public.campaign_creation_outbox set available_at=clock_timestamp()+interval '1 hour' where batch_id<>${batch.id}`;
    const ledger=createCampaignCreationLedger(db);const claim=await ledger.claim(randomUUID(),[profileId]);
    expect(claim?.batchId).toBe(batch.id);
    const rows=await db.sql`update public.product_ads set state='archived' where org_id=${actor.orgId} and profile_id=${profileId} returning amazon_id`;
    expect(rows).toHaveLength(1);
    const reservation=await ledger.reserve(claim!,batch.nodes[0]!.nodeId,{id:randomUUID(),requestDigest:sha('synthetic request'),nodeRequestDigest:sha('synthetic node'),reservedAt:new Date().toISOString(),deadline:new Date(Date.now()+35_000).toISOString()});
    expect(reservation.kind).toBe('refused');
    const stopped=await ledger.load(claim!);
    expect(stopped.nodes.filter(row=>row.refusal==='dependency_failed')).toHaveLength(4);
    expect(campaignCreationBatchSummary(stopped).accounting.attempted).toBe(0);
    await db.sql`update public.product_ads set state='enabled' where org_id=${actor.orgId} and profile_id=${profileId}`;
  });
  async function executeNode(current: CampaignCreationBatch, nodeId: string, failed: boolean) {
      const ledger = createCampaignCreationLedger(db);
      await db.sql`update public.campaign_creation_outbox set available_at=clock_timestamp()+interval '1 hour' where batch_id<>${current.id}`;
      await db.sql`update public.campaign_creation_outbox set available_at=clock_timestamp() where batch_id=${current.id}`;
      const claim = await ledger.claim(randomUUID(), [profileId]); expect(claim?.batchId).toBe(current.id);
      const call = { requestDigest: sha(JSON.stringify([current.id,nodeId])), positions: [{ requestDigest: sha(nodeId), nodeFingerprint: current.nodes.find((row)=>row.nodeId===nodeId)!.nodeFingerprint }] };
      if (current.lineage) await ledger.observe(current.id,nodeId,readEvidence(current,nodeId,call.requestDigest,'not_found',null));
      const reservation = await ledger.reserve(claim!, nodeId, { id: randomUUID(), requestDigest: call.requestDigest,
        nodeRequestDigest: call.positions[0]!.requestDigest, reservedAt: new Date().toISOString(), deadline: new Date(Date.now()+35_000).toISOString() });
      expect(reservation.kind).toBe('dispatch_once'); if (reservation.kind !== 'dispatch_once') throw new Error('Synthetic reservation failed');
      const intent = reservation.intent;
      const result = CampaignCreationProviderResult.parse({ effect: 'irreversible_create', planId: current.plan.id, nodeId,
        executionId: current.id, attemptId: intent.id, providerCallId: intent.id, nodeFingerprint: call.positions[0]!.nodeFingerprint,
        requestIndex: 0, requestDigest: intent.requestDigest, nodeRequestDigest: intent.nodeRequestDigest,
        outcome: failed ? 'authoritative_rejected' : 'succeeded', providerEntityId: failed ? null : String(92000 + current.plan.nodes.findIndex((node) => node.nodeId===nodeId)),
        providerEntityVersion: null, providerCode: failed ? 'INVALID_ARGUMENT' : null, sanitizedMessage: null, providerRequestId: null,
        responseDigest: sha('Synthetic response'), startedAt: intent.reservedAt, completedAt: new Date().toISOString() });
      await ledger.result(current.id,nodeId,result); await ledger.result(current.id,nodeId,result);
      if (!failed) await ledger.observe(current.id,nodeId,{ ...readEvidence(current,nodeId,call.requestDigest,'observed',result.providerEntityId!),mode:'provider_id' });
      await ledger.settle(claim!); return ledger.load(claim!);
    }
  it('observes and mirrors three parents, records keyword failure, and admits only that keyword as a retry', async () => {
    const { saved, measured } = await draft(); let batch = await approve(saved, measured);
    for (const node of batch.nodes) batch=await executeNode(batch,node.nodeId,batch.plan.nodes.find((item)=>item.nodeId===node.nodeId)?.kind==='target.create');
    expect(campaignCreationBatchSummary(batch)).toMatchObject({ state:'partial_failed',accounting:{parsed:4,loaded:4,attempted:4,succeeded:3,failed:1,observed:3} });
    const failedNodeIds=campaignCreationBatchSummary(batch).failedNodeIds; expect(failedNodeIds).toHaveLength(1);
    const retryRequest={...request(saved),action:'retry' as const,parentBatchId:batch.id,nodeIds:failedNodeIds};
    const child=await withAuthenticatedOrgEditor(db,actor,(tx)=>admitCampaignCreation(tx,retryRequest,measured));
    expect(child.nodes.map((row)=>row.nodeId)).toEqual(failedNodeIds); expect(child.lineage?.inheritedResources).toHaveLength(3);
    const complete=await executeNode(child,failedNodeIds[0]!,false);
    expect(campaignCreationBatchSummary(complete)).toMatchObject({state:'observed',accounting:{parsed:1,attempted:1,succeeded:1,observed:1}});
    const [mirror]=await db.sql`select (select count(*)::int from public.campaigns where org_id=${actor.orgId} and state='paused') as campaigns,
      (select count(*)::int from public.ad_groups where org_id=${actor.orgId} and state='paused') as groups,
      (select count(*)::int from public.product_ads where org_id=${actor.orgId} and state='paused') as ads,
      (select count(*)::int from public.keywords where org_id=${actor.orgId} and state='paused') as keywords,
      (select count(*)::int from public.campaign_creation_observations where batch_id in (${batch.id},${child.id})) as observations`;
    expect(mirror).toEqual({campaigns:1,groups:1,ads:1,keywords:1,observations:5});
    await expect(withAuthenticatedOrgEditor(db,actor,(tx)=>admitCampaignCreation(tx,{...retryRequest,nodeIds:[batch.nodes[0]!.nodeId]},measured))).rejects.toMatchObject({code:'retry_not_allowed'});
  });
  it('refuses later nodes when a recorded parent changed in the synchronized mirror', async () => {
    const { saved, measured } = await draft();
    let batch = await approve(saved, measured);
    batch = await executeNode(batch, batch.nodes[0]!.nodeId, false);
    const campaignId = batch.nodes[0]!.result!.providerEntityId;
    await db.sql`update public.campaigns set state='enabled' where org_id=${actor.orgId} and profile_id=${profileId} and amazon_id=${campaignId}`;
    await db.sql`update public.campaign_creation_outbox set available_at=clock_timestamp() where batch_id=${batch.id}`;
    const ledger = createCampaignCreationLedger(db);
    const claim = await ledger.claim(randomUUID(), [profileId]);
    expect(claim?.batchId).toBe(batch.id);
    const result = await ledger.reserve(claim!, batch.nodes[1]!.nodeId, { id: randomUUID(), requestDigest: 'a'.repeat(64),
      nodeRequestDigest: 'b'.repeat(64), reservedAt: new Date().toISOString(), deadline: new Date(Date.now()+35_000).toISOString() });
    expect(result.kind).toBe('refused');
    const current = await ledger.load(claim!);
    expect(current.nodes.filter((node) => node.intent !== null)).toHaveLength(1);
    expect(current.nodes.filter((node) => node.refusal === 'dependency_failed')).toHaveLength(3);
    expect(campaignCreationBatchSummary(current)).toMatchObject({ accounting: { parsed: 4, loaded: 4, attempted: 1, succeeded: 1, observed: 1, blocked: 3 } });
  });

  it('retains the four unmeasured checks in an admitted batch', async () => {
    const { saved } = await draft();
    const batch = await approve(saved, saved.validation!);
    expect(batch.validation.checks.filter((check) => check.status === 'not_measured')).toHaveLength(4);
    expect(batch.validation.checks.every((check) => !check.blocking)).toBe(true);
  });

  async function lostCampaign() {
    const { saved, measured } = await draft(); const batch = await approve(saved, measured);
    const ledger = createCampaignCreationLedger(db); const claim = await ledger.claim(randomUUID(), [profileId]);
    expect(claim?.batchId).toBe(batch.id); const nodeId = batch.nodes[0]!.nodeId;
    const requestDigest = sha(JSON.stringify([batch.id,nodeId]));
    expect((await ledger.reserve(claim!,nodeId,{ id:randomUUID(),requestDigest,nodeRequestDigest:sha(nodeId),
      reservedAt:new Date().toISOString(),deadline:new Date(Date.now()+35_000).toISOString() })).kind).toBe('dispatch_once');
    // Seed an aged synthetic reservation to exercise the DB clock boundary without sleeping in the suite.
    await db.sql`update public.campaign_creation_batch_nodes set intent=intent||jsonb_build_object(
      'reservedAt',app.sp_write_instant(clock_timestamp()-interval '180 seconds'),
      'deadline',app.sp_write_instant(clock_timestamp()-interval '145 seconds')) where batch_id=${batch.id} and node_id=${nodeId}`;
    return { saved, measured, batch, ledger, claim:claim!, nodeId, requestDigest };
  }

  it('adopts a lost response by observation while preserving the absent POST result and replaying scans once', async () => {
    const run = await lostCampaign();
    const read = readEvidence(run.batch,run.nodeId,run.requestDigest,'observed','93001');
    await run.ledger.observe(run.batch.id,run.nodeId,read);
    await run.ledger.observe(run.batch.id,run.nodeId,read);
    await expect(run.ledger.observe(run.batch.id,run.nodeId,{...read,providerEntityId:'93002'})).rejects.toThrow('replay changed');
    const batch = await run.ledger.load(run.claim);
    expect(batch.nodes[0]!.result).toBeNull(); expect(batch.nodes[0]!.observations).toHaveLength(1);
    expect(campaignCreationBatchSummary(batch).accounting).toMatchObject({attempted:1,providerSucceeded:0,adopted:1,succeeded:1,observed:1});
    const [mirror] = await db.sql`select amazon_id,state from public.campaigns where org_id=${actor.orgId} and amazon_id='93001'`;
    expect(mirror).toEqual({amazon_id:'93001',state:'paused'});
  });

  it('requires distinct complete empty scans 60 seconds apart, then transfers the exact graph to an explicit child', async () => {
    const run = await lostCampaign();
    const seed = async (seconds: number, complete: boolean) => {
      const at = new Date(Date.now()-seconds*1000).toISOString();
      const read = {...readEvidence(run.batch,run.nodeId,run.requestDigest,complete?'not_found':'pending',null),
        complete,startedAt:at,observedAt:at,accounting:{pages:1,loaded:0,parsed:0,matched:0}};
      await db.sql`insert into public.campaign_creation_observations(org_id,profile_id,batch_id,node_id,recorded_at,artifact,provider_artifact)
        values(${actor.orgId},${profileId},${run.batch.id},${run.nodeId},${at},${JSON.stringify(read)}::jsonb,${JSON.stringify(read)}::jsonb)`;
    };
    await seed(90,false); await seed(30,true);
    const first = readEvidence(run.batch,run.nodeId,run.requestDigest,'not_found',null);
    await run.ledger.observe(run.batch.id,run.nodeId,first); await run.ledger.observe(run.batch.id,run.nodeId,first);
    expect((await run.ledger.load(run.claim)).nodes[0]!.observation!.observation).toBe('not_found');
    await seed(61,true);
    await run.ledger.observe(run.batch.id,run.nodeId,readEvidence(run.batch,run.nodeId,run.requestDigest,'not_found',null));
    await run.ledger.settle(run.claim);
    const parent = await run.ledger.load(run.claim);
    expect(parent.nodes[0]!.observations).toHaveLength(5);
    expect(parent.nodes[0]!.observation).toMatchObject({observation:'uncertain',reason:expect.stringContaining('60 seconds apart')});
    expect(campaignCreationBatchSummary(parent)).toMatchObject({state:'needs_attention',terminal:true,accounting:{attempted:1,blocked:3}});
    const selection = campaignCreationRetrySelection(parent); expect(selection.nodeIds).toHaveLength(4);
    const input = {...request(run.saved),action:'retry' as const,parentBatchId:parent.id,nodeIds:selection.nodeIds};
    await expect(withAuthenticatedOrgEditor(db,actor,(tx)=>admitCampaignCreation(tx,{...input,nodeIds:[run.nodeId]},run.measured))).rejects.toMatchObject({code:'retry_not_allowed'});
    const child = await withAuthenticatedOrgEditor(db,actor,(tx)=>admitCampaignCreation(tx,input,run.measured));
    expect((await withAuthenticatedOrgEditor(db,actor,(tx)=>admitCampaignCreation(tx,input,run.measured))).id).toBe(child.id);
    expect(child.lineage?.inheritedResources).toHaveLength(0);
    const childClaim = await run.ledger.claim(randomUUID(),[profileId]); expect(childClaim?.batchId).toBe(child.id);
    const digest = sha(JSON.stringify([child.id,run.nodeId]));
    const intent = {id:randomUUID(),requestDigest:digest,nodeRequestDigest:sha(run.nodeId),reservedAt:new Date().toISOString(),deadline:new Date(Date.now()+35_000).toISOString()};
    expect((await run.ledger.reserve(childClaim!,run.nodeId,intent)).kind).toBe('pending');
    await run.ledger.observe(child.id,run.nodeId,readEvidence(child,run.nodeId,digest,'observed','94001'));
    expect((await run.ledger.reserve(childClaim!,run.nodeId,intent)).kind).toBe('refused');
    const adopted = await run.ledger.load(childClaim!);
    expect(campaignCreationBatchSummary(adopted).accounting).toMatchObject({attempted:0,adopted:1,observed:1});
    const queue = await withAuthenticatedReadSnapshot(db,actor,(tx)=>listChangeQueue(tx,{orgId:actor.orgId,profileId,entityType:'campaign_creation'}));
    expect(queue).toHaveLength(2);
    expect(queue.map((row)=>row.source).sort()).toEqual(['campaign_creation','campaign_creation_retry']);
    expect(queue.find((row)=>row.batchId===parent.id)?.state).toBe('needs_attention');
    expect(queue.find((row)=>row.batchId===child.id)?.reviewHref).toContain(`batch=${child.id}`);
    const next=child.nodes[1]!;const nextDigest=sha(JSON.stringify([child.id,next.nodeId]));
    await run.ledger.observe(child.id,next.nodeId,readEvidence(child,next.nodeId,nextDigest,'not_found',null));
    await db.sql`delete from public.sp_write_profile_grant_heads where org_id=${actor.orgId} and profile_id=${profileId}`;
    expect((await run.ledger.reserve(childClaim!,next.nodeId,{...intent,id:randomUUID(),requestDigest:nextDigest,nodeRequestDigest:sha(next.nodeId)})).kind).toBe('refused');
    const gated=await run.ledger.load(childClaim!);
    expect(gated.nodes[0]).toMatchObject({intent:null,result:null,refusal:null,observation:{observation:'observed'}});
    expect(campaignCreationBatchSummary(gated).accounting).toMatchObject({attempted:0,adopted:1,observed:1,refused:3});
    await db.sql`insert into public.sp_write_profile_grant_heads(org_id,profile_id,grant_id,version_id) values(${actor.orgId},${profileId},${grantId},${grantVersion})`;

  });

  it('records ambiguous readback, closes dispatch and refuses every retry', async () => {
    const run = await lostCampaign();
    await run.ledger.observe(run.batch.id,run.nodeId,{...readEvidence(run.batch,run.nodeId,run.requestDigest,'ambiguous_readback',null),reason:'More than one exact identity matched.'});
    await run.ledger.settle(run.claim); const parent = await run.ledger.load(run.claim);
    expect(campaignCreationRetrySelection(parent).available).toBe(false);
    expect(campaignCreationBatchSummary(parent)).toMatchObject({state:'needs_attention',terminal:true});
    await expect(withAuthenticatedOrgEditor(db,actor,(tx)=>admitCampaignCreation(tx,{...request(run.saved),action:'retry',parentBatchId:parent.id,nodeIds:[run.nodeId]},run.measured))).rejects.toMatchObject({code:'retry_not_allowed'});
    expect(await run.ledger.claim(randomUUID(),[profileId])).toBeNull();
  });

  it('paginates creation beside every existing source without losing rows and scopes the badge', async () => {
    const read = (before: {observedAt:string;id:string}|null, limit=50) => withAuthenticatedReadSnapshot(db,actor,
      (tx)=>listChangeQueue(tx,{orgId:actor.orgId,profileId,before,limit}));
    const original = await read(null,2000);
    const badge = await withAuthenticatedReadSnapshot(db,actor,(tx)=>countChangeQueue(tx,{orgId:actor.orgId,profileId}));
    for (let i=0;i<53;i++) { const data=await draft(); await approve(data.saved,data.measured); }
    const first = await read(null); expect(first).toHaveLength(50);
    const last=first.at(-1)!; expect(last.source).toBe('campaign_creation');
    const second=await read({observedAt:last.when,id:last.id},2000);
    const all=[...first,...second]; expect(all).toHaveLength(original.length+53);
    expect(new Set(all.map((row)=>row.id)).size).toBe(all.length);
    expect(all.filter((row)=>row.source==='campaign_creation')).toHaveLength(53);
    expect(await withAuthenticatedReadSnapshot(db,actor,(tx)=>countChangeQueue(tx,{orgId:actor.orgId,profileId}))).toBe(badge+53);
    expect(await withAuthenticatedReadSnapshot(db,other,(tx)=>listChangeQueue(tx,{orgId:other.orgId,profileId,source:'campaign_creation'}))).toEqual([]);
    expect(await withAuthenticatedReadSnapshot(db,other,(tx)=>countChangeQueue(tx,{orgId:other.orgId,profileId}))).toBe(0);
  });

  function readEvidence(current: CampaignCreationBatch, nodeId: string, requestDigest: string,
    observation: CampaignCreationBatchObservation['observation'], providerEntityId: string | null): CampaignCreationBatchObservation {
    const at = new Date().toISOString(); const matched = observation === 'not_found' ? 0 : observation === 'ambiguous_readback' ? 2 : 1;
    return { id: randomUUID(), mode: 'identity', identityFingerprint: sha(JSON.stringify([current.plan.id,nodeId])), requestDigest,
      responseDigest: sha('Synthetic read'), providerEntityId, observation, complete: true,
      accounting: { pages: 1, loaded: matched, parsed: matched, matched }, startedAt: at, observedAt: at, reason: null };
  }
});
