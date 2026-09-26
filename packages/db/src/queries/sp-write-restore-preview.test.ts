import { createHash, randomUUID } from 'node:crypto';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { spWriteRestoreProposals, spWriteRestoreReviews } from '../schema/restore-proposals.js';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { COORDINATED_RESTORE_UNAVAILABLE, OneTimeRpcSnapshot, serializeApplyRows, type ApplyRow } from '@wizard-ads/shared';
import { SpWritePreview, spWriteConfirmation, type SpWriteConfirmedApprovalRequest } from '@wizard-ads/shared/sp-write-application';
import { spWritePlanBinding, serializeSpWritePlanFingerprint, serializeSpWriteActionFingerprint } from '@wizard-ads/shared/sp-writes';
import { serializeSpWritePreviewGuardrails, serializeSpWritePreviewProvenance } from '@wizard-ads/shared/sp-write-preview-evidence';
import { createTestDatabase, type TestDatabase } from '../testing/harness.js';
import { withAuthenticatedOrgEditor, withAuthenticatedActor, withAuthenticatedReadSnapshot } from './authenticated-actor.js';
import { buildRestoreProposal, readRestoreProposal, recordRestoreProposal, reviewRestoreProposal } from './sp-write-restore-preview.js';
import { approveSpWriteForActor, readRecordedSpWritePreviewForActor } from './sp-write-commands.js';
import { syntheticRecommendationMethodInputs } from '../testing/recommendation-method.js';
import { buildSpWriteLegacyPreview } from './sp-write-plan-builder.js';
import { getReversionBatchPreview, listChangeQueue } from './time-machine.js';
import { recordEntityChanges } from './entities.js';
import { createRequestDatabase } from './request-client.js';
import { exportOptimizerSelection, readOptimizerExportBinding } from './optimizer-export.js';
import { readOptimizationWorkspace } from './optimization-groups.js';
let db:TestDatabase, orgId:string,profileId:string,runId:string,otherOrg:string;
const userId=randomUUID(),otherUser=randomUUID();
const actor=()=>({orgId,userId});
beforeAll(async()=>{
  db=await createTestDatabase('restore_proposals');
  const gate=randomUUID();
  await db.sql`insert into public.sp_write_environment_gate_versions(version_id,enabled,max_unresolved_calls) values(${gate},true,1)`;
  await db.sql`insert into public.sp_write_environment_gate_head(singleton,version_id) values(true,${gate})`;
  const [tenant]=await db.sql<{id:string;other:string}[]>`select app.seed_tenant_fixture('synthetic-restore',${userId},'owner') as id,app.seed_tenant_fixture('synthetic-restore-other',${otherUser},'owner') as other`;
  orgId=tenant!.id;otherOrg=tenant!.other;
  const [profile]=await db.sql<{id:string}[]>`select id from public.ad_profiles where org_id=${orgId}`;profileId=profile!.id;
  const [run]=await db.sql<{id:string}[]>`select id from public.recommendation_runs where org_id=${orgId} limit 1`;runId=run!.id;
  const version=randomUUID();
  await db.sql`insert into public.sp_write_profile_grant_versions(grant_id,version_id,org_id,profile_id,enabled,amazon_profile_id,connection_id,region,marketplace_id,currency_code,api_dialect,created_by)
    select g.grant_id,${version},g.org_id,g.profile_id,true,g.amazon_profile_id,g.connection_id,g.region,g.marketplace_id,g.currency_code,g.api_dialect,g.created_by
    from public.sp_write_profile_grant_versions g join public.sp_write_profile_grant_heads h on h.version_id=g.version_id where h.org_id=${orgId} and h.profile_id=${profileId}`;
  await db.sql`update public.sp_write_profile_grant_heads set version_id=${version} where org_id=${orgId} and profile_id=${profileId}`;
},180000);
afterAll(async()=>{await db?.drop();});
async function fixture(reassignmentProbe=false, executable=false) {
  const batchId=randomUUID(),rowIds=Array.from({length:reassignmentProbe?2:7},()=>randomUUID()), prefix=randomUUID();
  const entities=rowIds.map((_,i)=>`${prefix}-${i}`);
  const artifactRows:ApplyRow[]=entities.map((entityId,i)=>({entityType:'keyword',entityId,field:i===5?'placement':'bid',old:reassignmentProbe && i===1?0.5:1,new:2}));
  const hash=createHash('sha256').update(serializeApplyRows(artifactRows)).digest('hex');
  await db.sql`insert into public.apply_batches(id,org_id,profile_id,tag,opt_group,lever,note,exported_at,exported_proposals,reversible_rows,unsupported_rows,artifact_sha256)
    values(${batchId},${orgId},${profileId},${batchId},'synthetic','bid','Synthetic restore evidence',now()-interval '1 hour',${rowIds.length},${rowIds.length},0,${hash})`;
  for(const [i,rowId] of rowIds.entries()) {
    const rec=randomUUID(),entity=entities[i]!,oldJson=JSON.stringify(artifactRows[i]!.old);
    await db.sql`insert into public.keywords(org_id,profile_id,amazon_id,ad_product,state,campaign_id,ad_group_id,keyword_text,match_type,bid,synced_at)
      values(${orgId},${profileId},${entity},'SP','enabled','c-1','ag-1','Synthetic restore','exact',${i===2?3:i===3?1:i===4?4:2},case when ${i===6} then now()-interval '2 hours' else now() end)`;
    await db.sql`insert into public.recommendations(id,run_id,org_id,profile_id,reason,entity_type,entity_id,field,current_value,proposed_value,inputs)
      values(${rec},${runId},${orgId},${profileId},'high_acos','keyword',${entity},${i===5?'placement':'bid'},${oldJson}::jsonb,'2',${JSON.stringify(executable ? syntheticRecommendationMethodInputs(1) : {})}::jsonb)`;
    await db.sql`insert into public.apply_rows(id,batch_id,org_id,profile_id,recommendation_id,entity_type,entity_id,field,old_value,new_value)
      values(${rowId},${batchId},${orgId},${profileId},${rec},'keyword',${entity},${i===5?'placement':'bid'},${oldJson}::jsonb,'2')`;
    await db.sql`update public.recommendations set status='exported',export_batch_id=${batchId} where id=${rec}`;
  }
  await recordEntityChanges(db,entities.slice(0,reassignmentProbe?1:5).map(amazonId=>({orgId,profileId,entityType:'keyword' as const,amazonId,field:'bid',oldValue:1,newValue:2,source:'sync' as const,observedAt:new Date()})));
  await db.sql`update public.keywords set synced_at=clock_timestamp() where org_id=${orgId} and amazon_id=any(${entities.slice(0,6)})`;
  return {batchId,rowIds,entities,request:{requestId:randomUUID(),profileId,applyBatchId:batchId,sourceRowIds:rowIds.slice(0,reassignmentProbe?1:2)}};
}
it('builds exactly the two ready rows out of seven, records immutable evidence, reviews without outbox or provider calls',async()=>{
  const f=await fixture();
  const [initial]=await db.sql`select (select count(*)::int from public.sp_write_execution_requests) as outbox,(select count(*)::int from public.sp_write_provider_call_intents) as calls`;
  const before=await getReversionBatchPreview(db,{orgId,batchId:f.batchId});
  expect(before?.rows).toHaveLength(7);expect(before?.rows.filter(row=>row.state==='ready')).toHaveLength(2);
  const preview=await withAuthenticatedOrgEditor(db,actor(),tx=>buildRestoreProposal(tx,f.request));
  expect(preview.plan.actions).toHaveLength(2);
  expect((await getReversionBatchPreview(db,{orgId,batchId:f.batchId}))?.rows).toHaveLength(7);
  expect(preview.plan.actions.map(action=>action.routeKey==='sp.v3.keywords.update' ? action.changes.bid : null)).toEqual(Array(2).fill({expected:{amount:'2',currencyCode:'USD'},requested:{amount:'1',currencyCode:'USD'}}));
  expect(preview.plan.source.kind==='apply_batch' && preview.plan.source.restoreProposal?.sourceRowIds).toEqual(f.request.sourceRowIds);
  const recovered=await withAuthenticatedOrgEditor(db,actor(),tx=>buildRestoreProposal(tx,f.request));expect(recovered).toEqual(preview);
  const queued=await listChangeQueue(db,{orgId,profileId,source:'restore'});expect(queued).toHaveLength(1);
  expect(queued[0]!.actor).toEqual({ kind: 'operator', name: null });
  expect(queued[0]).toMatchObject({state:'awaiting review',reviewHref:expect.stringContaining(f.request.requestId)});
  await expect(db.sql`update public.sp_write_plans set artifact_text='{}' where plan_id=${preview.plan.id}`).rejects.toThrow();
  await expect(db.sql`delete from public.sp_write_restore_proposals where plan_id=${preview.plan.id}`).rejects.toThrow();
  await expect(db.sql`update public.sp_write_preview_evidence set artifact_text='{}' where plan_id=${preview.plan.id}`).rejects.toThrow();
  await withAuthenticatedOrgEditor(db,actor(),tx=>reviewRestoreProposal(tx,{profileId,planId:preview.plan.id,fingerprint:preview.plan.fingerprint}));
  expect((await listChangeQueue(db,{orgId,profileId,source:'restore'}))[0]?.state).toBe('approved');
  const [counts]=await db.sql`select (select count(*)::int from public.sp_write_execution_requests) as outbox,(select count(*)::int from public.sp_write_provider_call_intents) as calls`;
  expect(counts).toEqual(initial);
  const [created]=await db.sql`select (select count(*)::int from public.sp_write_execution_requests where plan_id=${preview.plan.id}) as outbox,(select count(*)::int from public.sp_write_provider_call_intents where plan_id=${preview.plan.id}) as calls`;
  expect(created).toEqual({outbox:0,calls:0});
});
it('refuses a current value changed after the preview at the database boundary',async()=>{
  const f=await fixture();
  const built=await buildSpWriteLegacyPreview(db.sql,orgId,f.request,f.request.sourceRowIds);
  const preview=SpWritePreview.parse({...built,binding:spWritePlanBinding(built.plan)});
  await db.sql`update public.keywords set bid=3 where org_id=${orgId} and amazon_id=${f.entities[0]!}`;
  await expect(withAuthenticatedOrgEditor(db,actor(),tx=>recordRestoreProposal(tx,preview))).rejects.toThrow('SP preview source or policy changed');
  const [count]=await db.sql`select count(*)::int as n from public.sp_write_plans where plan_id=${preview.plan.id}`;expect(count?.n).toBe(0);
});
it('round trips the guarded proposal through the web request database client',async()=>{
  const f=await fixture(),requestDb=createRequestDatabase(db.connectionString);
  try {
    const preview=await withAuthenticatedOrgEditor(requestDb,actor(),tx=>buildRestoreProposal(tx,f.request));
    expect(preview.plan.actions).toHaveLength(2);
    const saved=await withAuthenticatedActor(requestDb,actor(),sql=>readRestoreProposal({sql},{orgId,profileId,planId:preview.plan.id}));
    expect(saved?.preview).toEqual(preview);
    await withAuthenticatedOrgEditor(requestDb,actor(),tx=>reviewRestoreProposal(tx,{profileId,planId:preview.plan.id,fingerprint:preview.plan.fingerprint}));
    const [counts]=await db.sql`select (select count(*)::int from public.sp_write_execution_requests where plan_id=${preview.plan.id}) as outbox,(select count(*)::int from public.sp_write_provider_call_intents where plan_id=${preview.plan.id}) as calls`;
    expect(counts).toEqual({outbox:0,calls:0});
  } finally {await requestDb.close();}
});
it('refuses a blocked selection and cross-agency creation, reading and review',async()=>{
  const f=await fixture();
  await expect(withAuthenticatedOrgEditor(db,actor(),tx=>buildRestoreProposal(tx,{...f.request,sourceRowIds:f.rowIds.slice(0,3)}))).rejects.toMatchObject({code:'source_changed'});
  await withAuthenticatedOrgEditor(db,actor(),tx=>buildRestoreProposal(tx,f.request));
  await expect(withAuthenticatedOrgEditor(db,{orgId:otherOrg,userId:otherUser},tx=>buildRestoreProposal(tx,f.request))).rejects.toThrow('Resource not found');
  expect(await withAuthenticatedActor(db,{orgId:otherOrg,userId:otherUser},sql=>readRestoreProposal({sql},{orgId:otherOrg,profileId,planId:f.request.requestId}))).toBeNull();
  await expect(withAuthenticatedOrgEditor(db,{orgId:otherOrg,userId:otherUser},tx=>reviewRestoreProposal(tx,{profileId,planId:f.request.requestId,fingerprint:'a'.repeat(64)}))).rejects.toThrow();
});

it('mirrors both restore receipt tables and exposes only tenant reads',async()=>{
  for(const table of [spWriteRestoreProposals,spWriteRestoreReviews]) {
    const config=getTableConfig(table);
    const columns=await db.sql<{name:string;type:string;required:boolean;defaulted:boolean}[]>`select a.attname as name,format_type(a.atttypid,a.atttypmod) as type,a.attnotnull as required,a.atthasdef as defaulted
      from pg_attribute a where a.attrelid=${`public.${config.name}`}::regclass and a.attnum>0 and not a.attisdropped order by a.attnum`;
    expect(config.columns.map(column=>({name:column.name,type:column.getSQLType(),required:column.notNull,defaulted:column.hasDefault}))).toEqual(columns);
    const fks=await db.sql<{n:number}[]>`select count(*)::int as n from pg_constraint where conrelid=${`public.${config.name}`}::regclass and contype='f'`;
    expect(fks[0]?.n).toBe(config.foreignKeys.length);
    const [rights]=await db.sql`select has_table_privilege('authenticated',${`public.${config.name}`},'select') as read,has_table_privilege('authenticated',${`public.${config.name}`},'insert,update,delete,truncate') as write`;
    expect(rights).toEqual({read:true,write:false});
  }
});

it('retains every coordinated row, including missing keyword, target and campaign mirrors, but refuses restoration', async () => {
  const batchId=randomUUID(), rowIds=Array.from({length:3},()=>randomUUID());
  await db.sql`insert into public.apply_batches(id,org_id,profile_id,tag,opt_group,lever,note,exported_proposals,reversible_rows,unsupported_rows,dependency_sets_count,artifact_sha256)
    values(${batchId},${orgId},${profileId},${batchId},'synthetic','coordinated','Synthetic dependency set',1,3,0,1,${'a'.repeat(64)})`;
  for (const [index,entityType] of ['keyword','target','campaign'].entries()) {
    await db.sql`insert into public.apply_rows(id,batch_id,org_id,profile_id,entity_type,entity_id,field,old_value,new_value,dependency_set_id,dependency_step_index)
      values(${rowIds[index]!},${batchId},${orgId},${profileId},${entityType!}::public.apply_entity_type,${randomUUID()},${entityType==='campaign'?'tos_modifier':'bid'},'1','2','synthetic-set',${index})`;
  }
  const preview=await getReversionBatchPreview(db,{orgId,batchId});
  expect(preview).toMatchObject({exportedProposals:1,reversibleRows:3,dependencySetCount:1,readyRows:0,blockedRows:3,exportAllowed:false,reason:COORDINATED_RESTORE_UNAVAILABLE});
  expect(preview?.rows).toHaveLength(3);
  const entries=(await listChangeQueue(db,{orgId,profileId})).filter(row=>row.batchId===batchId);
  expect(entries).toHaveLength(3);
  expect(entries.every(row=>row.batchCount===3)).toBe(true);
  expect(preview?.rows.map(row=>row.entityType).sort()).toEqual(['campaign','keyword','target']);
  for(const row of preview!.rows) expect(row).toMatchObject({state:'unsupported',reason:COORDINATED_RESTORE_UNAVAILABLE,currentValue:null,currentSyncedAt:null,exportAllowed:false});
  const request={requestId:randomUUID(),profileId,applyBatchId:batchId,sourceRowIds:rowIds};
  await expect(withAuthenticatedOrgEditor(db,actor(),tx=>buildRestoreProposal(tx,request))).rejects.toThrow(COORDINATED_RESTORE_UNAVAILABLE);
  await expect(buildSpWriteLegacyPreview(db.sql,orgId,request,rowIds.slice(0,1))).rejects.toMatchObject({code:'unsupported_source'});
  const [counts]=await db.sql`select (select count(*)::int from public.sp_write_plans where plan_id=${request.requestId}) as plans,
    (select count(*)::int from public.sp_write_execution_requests where plan_id=${request.requestId}) as outbox,
    (select count(*)::int from public.sp_write_provider_call_intents where plan_id=${request.requestId}) as calls`;
  expect(counts).toEqual({plans:0,outbox:0,calls:0});
});
it('refuses dependency metadata added after a single-control restore snapshot at SQL admission',async()=>{
  const f=await fixture();
  const built=await buildSpWriteLegacyPreview(db.sql,orgId,f.request,f.request.sourceRowIds);
  const preview=SpWritePreview.parse({...built,binding:spWritePlanBinding(built.plan)});
  await db.sql`update public.apply_rows set dependency_set_id='synthetic-set',dependency_step_index=0 where id=${f.rowIds[0]!}`;
  await expect(withAuthenticatedOrgEditor(db,actor(),tx=>recordRestoreProposal(tx,preview))).rejects.toThrow('SP preview source or policy changed');
  await expect(buildSpWriteLegacyPreview(db.sql,orgId,f.request,f.request.sourceRowIds)).rejects.toMatchObject({code:'unsupported_source'});
  const [count]=await db.sql`select count(*)::int as n from public.sp_write_plans where plan_id=${preview.plan.id}`;
  expect(count?.n).toBe(0);
});

async function pendingPair(f:Awaited<ReturnType<typeof fixture>>) {
  const admitted=await withAuthenticatedOrgEditor(db,actor(),tx=>buildRestoreProposal(tx,f.request));
  const built=await buildSpWriteLegacyPreview(db.sql,orgId,{...f.request,requestId:randomUUID()},f.request.sourceRowIds);
  return {admitted,pending:SpWritePreview.parse({...built,binding:spWritePlanBinding(built.plan)})};
}
async function refusedAtBothBoundaries(pair:Awaited<ReturnType<typeof pendingPair>>,reason:string) {
  await expect(withAuthenticatedOrgEditor(db,actor(),tx=>recordRestoreProposal(tx,pair.pending))).rejects.toMatchObject({code:'55000',detail:reason});
  await expect(withAuthenticatedOrgEditor(db,actor(),tx=>reviewRestoreProposal(tx,{profileId,planId:pair.admitted.plan.id,fingerprint:pair.admitted.plan.fingerprint}))).rejects.toMatchObject({code:'55000',detail:reason});
  const [counts]=await db.sql`select (select count(*)::int from public.sp_write_plans where plan_id=${pair.pending.plan.id}) as admitted,
    (select count(*)::int from public.sp_write_restore_reviews where plan_id=${pair.admitted.plan.id}) as reviews,
    (select count(*)::int from public.sp_write_execution_requests where plan_id=any(${[pair.pending.plan.id,pair.admitted.plan.id]}::uuid[])) as outbox,
    (select count(*)::int from public.sp_write_provider_call_intents where plan_id=any(${[pair.pending.plan.id,pair.admitted.plan.id]}::uuid[])) as calls`;
  expect(counts).toEqual({admitted:0,reviews:0,outbox:0,calls:0});
}
it('refuses the authenticated owner source-reassignment probe at construction, SQL admission and review (source_changed)',async()=>{
  const f=await fixture(true),pair=await pendingPair(f);
  await withAuthenticatedOrgEditor(db,actor(),async tx=>{
    await tx.sql`update public.apply_rows set entity_id=${f.entities[1]!},recommendation_id=(select recommendation_id from public.apply_rows where id=${f.rowIds[1]!}),old_value='0.5'::jsonb where id=${f.rowIds[0]!}`;
  });
  const [probe]=await db.sql`select ar.entity_id<>ec.amazon_id as entity_changed,ar.old_value<>ec.old_value as before_changed
    from public.apply_rows ar join public.entity_changes ec on ec.apply_row_id=ar.id where ar.id=${f.rowIds[0]!}`;
  expect(probe).toEqual({entity_changed:true,before_changed:true});
  await expect(withAuthenticatedOrgEditor(db,actor(),tx=>buildRestoreProposal(tx,{...f.request,requestId:randomUUID()}))).rejects.toMatchObject({code:'source_changed'});
  await refusedAtBothBoundaries(pair,'source_changed');
  await expect(withAuthenticatedOrgEditor(db,actor(),tx=>tx.sql`update public.apply_batches set artifact_sha256=${'a'.repeat(64)} where id=${f.batchId}`)).rejects.toMatchObject({detail:'source_changed'});
});
it('refuses the mirror-older-than-write probe at construction, SQL admission and review (restore_mirror_stale)',async()=>{
  const f=await fixture(),pair=await pendingPair(f);
  await db.sql`update public.keywords set synced_at=now()-interval '30 minutes' where org_id=${orgId} and amazon_id=any(${f.entities.slice(0,2)})`;
  const batch=await getReversionBatchPreview(db,{orgId,batchId:f.batchId});
  expect(batch?.rows.filter(row=>f.request.sourceRowIds.some(id=>id===row.rowId)).map(row=>row.state)).toEqual(['awaiting_sync','awaiting_sync']);
  await expect(withAuthenticatedOrgEditor(db,actor(),tx=>buildRestoreProposal(tx,{...f.request,requestId:randomUUID()}))).rejects.toMatchObject({code:'restore_mirror_stale'});
  await refusedAtBothBoundaries(pair,'restore_mirror_stale');
});
it('refuses the active-reversion probe at construction, SQL admission and review (restore_active_reversion)',async()=>{
  const f=await fixture(),pair=await pendingPair(f);
  await withAuthenticatedOrgEditor(db,actor(),tx=>tx.sql`insert into public.apply_batches(org_id,profile_id,tag,opt_group,lever,note,source_batch_id,exported_proposals,reversible_rows,unsupported_rows)
    values(${orgId},${profileId},${randomUUID()},'synthetic','bid','Synthetic active reversion',${f.batchId},0,0,0)`);
  const batch=await getReversionBatchPreview(db,{orgId,batchId:f.batchId});
  expect(batch).toMatchObject({exportAllowed:false,reason:'This batch already has an active reversion export.'});
  expect(batch?.readyRows).toBe(2);
  await expect(withAuthenticatedOrgEditor(db,actor(),tx=>buildRestoreProposal(tx,{...f.request,requestId:randomUUID()}))).rejects.toMatchObject({code:'restore_active_reversion'});
  await refusedAtBothBoundaries(pair,'restore_active_reversion');
});

it('binds even unselected rows to the complete original export at admission and review (source_changed)',async()=>{
  const f=await fixture(),pair=await pendingPair(f);
  await withAuthenticatedOrgEditor(db,actor(),tx=>tx.sql`update public.apply_rows set old_value='0.25'::jsonb where id=${f.rowIds[6]!}`);
  await expect(withAuthenticatedOrgEditor(db,actor(),tx=>buildRestoreProposal(tx,{...f.request,requestId:randomUUID()}))).rejects.toMatchObject({code:'source_changed'});
  await refusedAtBothBoundaries(pair,'source_changed');
});
it('requires the linked observation to match every original export field (source_changed)',async()=>{
  const f=await fixture(true),pair=await pendingPair(f);
  for(const field of ['entity_type','amazon_id','field','old_value','new_value']) {
    await db.sql`update public.entity_changes set entity_type='keyword',amazon_id=${f.entities[0]!},field='bid',old_value='1',new_value='2' where apply_row_id=${f.rowIds[0]!}`;
    if(field==='entity_type') await db.sql`update public.entity_changes set entity_type='target' where apply_row_id=${f.rowIds[0]!}`;
    if(field==='amazon_id') await db.sql`update public.entity_changes set amazon_id=${f.entities[1]!} where apply_row_id=${f.rowIds[0]!}`;
    if(field==='field') await db.sql`update public.entity_changes set field='state' where apply_row_id=${f.rowIds[0]!}`;
    if(field==='old_value') await db.sql`update public.entity_changes set old_value='0.5' where apply_row_id=${f.rowIds[0]!}`;
    if(field==='new_value') await db.sql`update public.entity_changes set new_value='3' where apply_row_id=${f.rowIds[0]!}`;
    await refusedAtBothBoundaries(pair,'source_changed');
  }
});


async function executableRestore() {
  const f = await fixture(false, true);
  const preview = await withAuthenticatedOrgEditor(db, actor(), (tx) => buildRestoreProposal(tx, f.request));
  const request: SpWriteConfirmedApprovalRequest = { profileId,
    confirmation: spWriteConfirmation(preview.plan.counts.logicalChanges),
    approval: { approvalRequestId: randomUUID(), plan: preview.binding, approvalMode: 'manual',
      confirmationVersion: 'openspell.amazon-sp-write-confirmation.v1', boundedAuthorization: null, preapprovedInversePlan: null } };
  return { ...f, preview, request,
    approve: () => withAuthenticatedOrgEditor(db, actor(), (tx) => approveSpWriteForActor(tx, request)),
    read: () => withAuthenticatedReadSnapshot(db, actor(), (tx) => readRecordedSpWritePreviewForActor(tx, { profileId, planId: preview.plan.id })) };
}

it('admits exactly one restore batch and two row identities atomically, recovering the same approval on repeat', async () => {
  const f = await executableRestore();
  expect((await f.read()).freshness).toMatchObject({ status: 'current', reasons: [] });
  const [admitted, concurrentReplay] = await Promise.all([f.approve(), f.approve()]);
  expect(concurrentReplay).toEqual(admitted);
  expect(await f.approve()).toEqual(admitted);
  const [counts] = await db.sql`select
    (select count(*)::int from public.sp_write_authorization_receipts where plan_id=${f.preview.plan.id}) as receipts,
    (select count(*)::int from public.sp_write_cycle_plans where plan_id=${f.preview.plan.id}) as batches,
    (select count(*)::int from public.sp_write_execution_requests where plan_id=${f.preview.plan.id}) as requests,
    (select count(*)::int from public.sp_write_outbox where plan_id=${f.preview.plan.id}) as outbox,
    (select count(*)::int from app.sp_write_forward_admissions where plan_id=${f.preview.plan.id} and operation_kind='restore') as rows,
    (select count(*)::int from public.sp_write_provider_call_intents where plan_id=${f.preview.plan.id}) as calls`;
  expect(counts).toEqual({ receipts: 1, batches: 1, requests: 1, outbox: 1, rows: 2, calls: 0 });
  const queue = await listChangeQueue(db, { orgId, profileId, source: 'restore' });
  expect(queue.filter((row) => row.id === `restore:${f.preview.plan.id}`)).toEqual([expect.objectContaining({
    source: 'restore', state: 'admitted', batchId: f.batchId, batchCount: 2,
    reviewHref: expect.stringContaining(`/optimizer/run/${f.batchId}`) })]);
  expect((await f.read()).admission).toEqual(admitted);
});

it('refuses a moved mirror with source_changed and requires a new confirmation without any admitted rows', async () => {
  const f = await executableRestore();
  await db.sql`update public.keywords set synced_at=clock_timestamp() where org_id=${orgId} and amazon_id=${f.entities[0]!}`;
  expect((await f.read()).freshness).toMatchObject({ status: 'stale', reasons: expect.arrayContaining(['source_changed']) });
  await expect(f.approve()).rejects.toMatchObject({ code: '55000', detail: 'source_changed' });
  const [counts] = await db.sql`select (select count(*)::int from public.sp_write_cycle_plans where plan_id=${f.preview.plan.id}) as batches,
    (select count(*)::int from public.sp_write_outbox where plan_id=${f.preview.plan.id}) as outbox`;
  expect(counts).toEqual({ batches: 0, outbox: 0 });
});

it.each(['environment', 'profile'] as const)('refuses the disabled %s write gate with an explicit reason and no outbox', async (gate) => {
  const f = await executableRestore();
  const [head] = gate === 'environment'
    ? await db.sql<{ version_id: string }[]>`select version_id from public.sp_write_environment_gate_head where singleton`
    : await db.sql<{ version_id: string }[]>`select version_id from public.sp_write_profile_grant_heads where org_id=${orgId} and profile_id=${profileId}`;
  const version = randomUUID();
  if (gate === 'environment') {
    await db.sql`insert into public.sp_write_environment_gate_versions(version_id,enabled,max_unresolved_calls) values(${version},false,1)`;
    await db.sql`update public.sp_write_environment_gate_head set version_id=${version} where singleton`;
  } else {
    await db.sql`insert into public.sp_write_profile_grant_versions(grant_id,version_id,org_id,profile_id,enabled,amazon_profile_id,connection_id,region,marketplace_id,currency_code,api_dialect,created_by)
      select grant_id,${version},org_id,profile_id,false,amazon_profile_id,connection_id,region,marketplace_id,currency_code,api_dialect,created_by
      from public.sp_write_profile_grant_versions where version_id=${head!.version_id}`;
    await db.sql`update public.sp_write_profile_grant_heads set version_id=${version} where org_id=${orgId} and profile_id=${profileId}`;
  }
  try {
    const reason = gate === 'environment' ? 'gate_disabled' : 'profile_not_allowlisted';
    await expect(f.approve()).rejects.toMatchObject({ code: '55000', detail: reason });
    expect((await f.read()).freshness.reasons).toContain(gate === 'environment' ? 'gate_disabled' : 'grant_changed');
    const [count] = await db.sql`select count(*)::int as n from public.sp_write_execution_requests where plan_id=${f.preview.plan.id}`;
    expect(count?.n).toBe(0);
  } finally {
    if (gate === 'environment') await db.sql`update public.sp_write_environment_gate_head set version_id=${head!.version_id} where singleton`;
    else await db.sql`update public.sp_write_profile_grant_heads set version_id=${head!.version_id} where org_id=${orgId} and profile_id=${profileId}`;
  }
});

it('serializes two restore approvals of one source batch and refuses the second active reversion child', async () => {
  const f = await executableRestore();
  const second = await withAuthenticatedOrgEditor(db, actor(), (tx) => buildRestoreProposal(tx, {
    requestId: randomUUID(), profileId, applyBatchId: f.batchId, sourceRowIds: f.rowIds.slice(0, 2) }));
  const competing = await Promise.allSettled([f.approve(), withAuthenticatedOrgEditor(db, actor(), (tx) => approveSpWriteForActor(tx, {
    ...f.request, approval: { ...f.request.approval, approvalRequestId: randomUUID(), plan: second.binding } }))]);
  expect(competing.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const refused = competing.filter((result) => result.status === 'rejected');
  expect(refused).toHaveLength(1);
  expect(refused[0]!.reason).toMatchObject({ code: '55000', detail: 'restore_active_reversion' });
  const [count] = await db.sql`select count(*)::int as n from public.sp_write_cycle_plans c
    join public.sp_write_restore_proposals p on p.org_id=c.org_id and p.profile_id=c.profile_id and p.plan_id=c.plan_id
    where p.source_batch_id=${f.batchId}`;
  expect(count?.n).toBe(1);
});

it('requires the current owner or admin role when confirming a restore', async () => {
  const f = await executableRestore();
  await db.sql`update public.org_members set role='viewer' where org_id=${orgId} and user_id=${userId}`;
  try { await expect(f.approve()).rejects.toThrow(); }
  finally { await db.sql`update public.org_members set role='owner' where org_id=${orgId} and user_id=${userId}`; }
  const [count] = await db.sql`select count(*)::int as n from public.sp_write_cycle_plans where plan_id=${f.preview.plan.id}`;
  expect(count?.n).toBe(0);
});

it('admits an exact restore of historical rows without inventing missing recommendation method evidence', async () => {
  const f = await fixture();
  const preview = await withAuthenticatedOrgEditor(db, actor(), (tx) => buildRestoreProposal(tx, f.request));
  const recorded = await withAuthenticatedReadSnapshot(db, actor(), (tx) => readRecordedSpWritePreviewForActor(tx, { profileId, planId: preview.plan.id }));
  expect(recorded.freshness).toMatchObject({ status: 'current', reasons: [] });
  const admission = await withAuthenticatedOrgEditor(db, actor(), (tx) => approveSpWriteForActor(tx, { profileId,
    confirmation: spWriteConfirmation(preview.plan.counts.logicalChanges), approval: { approvalRequestId: randomUUID(), plan: preview.binding,
      approvalMode: 'manual', confirmationVersion: 'openspell.amazon-sp-write-confirmation.v1', boundedAuthorization: null, preapprovedInversePlan: null } }));
  expect(admission.kind).toBe('queued');
  const [count] = await db.sql`select count(*)::int as n from app.sp_write_forward_admissions where plan_id=${preview.plan.id} and operation_kind='restore'`;
  expect(count?.n).toBe(2);
});

it('refuses reassigned source evidence at authenticated approval and rolls back every authority row', async () => {
  const f = await executableRestore();
  await withAuthenticatedOrgEditor(db, actor(), (tx) => tx.sql`update public.apply_rows
    set entity_id=${f.entities[1]!},old_value='0.5'::jsonb where id=${f.rowIds[0]!}`);
  expect((await f.read()).freshness.reasons).toContain('source_changed');
  await expect(f.approve()).rejects.toMatchObject({ code: '55000', detail: 'source_changed' });
  const [counts] = await db.sql`select
    (select count(*)::int from public.sp_write_authorization_receipts where plan_id=${f.preview.plan.id}) as receipts,
    (select count(*)::int from public.sp_write_cycle_plans where plan_id=${f.preview.plan.id}) as batches,
    (select count(*)::int from public.sp_write_execution_requests where plan_id=${f.preview.plan.id}) as requests`;
  expect(counts).toEqual({ receipts: 0, batches: 0, requests: 0 });
});


it('refuses a generically staged restore without its exact restore proposal receipt at transaction closure', async () => {
  const f = await fixture();
  const built = await buildSpWriteLegacyPreview(db.sql, orgId, f.request, f.request.sourceRowIds);
  const preview = SpWritePreview.parse({ ...built, binding: spWritePlanBinding(built.plan) });
  await withAuthenticatedOrgEditor(db, actor(), async (tx) => {
    const [saved] = await tx.sql<{ id: string }[]>`select app.record_sp_write_preview_for_actor(
      ${orgId}::uuid,${userId}::uuid,${JSON.stringify(built.plan)},${serializeSpWritePlanFingerprint(built.plan)},
      ${JSON.stringify(built.plan.actions.map((action) => ({ artifactText: JSON.stringify(action),
        fingerprintPreimage: serializeSpWriteActionFingerprint(action) })))}::text::jsonb,
      ${JSON.stringify(built.evidence)},${serializeSpWritePreviewGuardrails(built.evidence)},
      ${serializeSpWritePreviewProvenance(built.evidence)})::text as id`;
    expect(saved?.id).toBe(preview.plan.id);
  });
  const [staged] = await db.sql`select (select count(*)::int from public.sp_write_plans where plan_id=${preview.plan.id}) as plans,
    (select count(*)::int from public.sp_write_restore_proposals where plan_id=${preview.plan.id}) as proposals`;
  expect(staged).toEqual({ plans: 1, proposals: 0 });
  await expect(withAuthenticatedOrgEditor(db, actor(), (tx) => approveSpWriteForActor(tx, { profileId,
    confirmation: spWriteConfirmation(preview.plan.counts.logicalChanges), approval: { approvalRequestId: randomUUID(), plan: preview.binding,
      approvalMode: 'manual', confirmationVersion: 'openspell.amazon-sp-write-confirmation.v1', boundedAuthorization: null, preapprovedInversePlan: null } })))
    .rejects.toMatchObject({ code: '55000', detail: 'source_changed' });
  const [counts] = await db.sql`select
    (select count(*)::int from public.sp_write_authorization_receipts where plan_id=${preview.plan.id}) as receipts,
    (select count(*)::int from public.sp_write_cycle_plans where plan_id=${preview.plan.id}) as batches,
    (select count(*)::int from public.sp_write_execution_requests where plan_id=${preview.plan.id}) as requests,
    (select count(*)::int from public.sp_write_outbox where plan_id=${preview.plan.id}) as outbox,
    (select count(*)::int from app.sp_write_forward_admissions where plan_id=${preview.plan.id}) as rows`;
  expect(counts).toEqual({ receipts: 0, batches: 0, requests: 0, outbox: 0, rows: 0 });
});

it('approves a restore of a one-time export after its application is synchronized', async () => {
  const snapshot = OneTimeRpcSnapshot.parse({ version: 1,
    configuration: { version: 1, method: 'sp.reference-efficiency', targetAcos: 0.27, bidFloor: 0.13, bidCeiling: 3.1,
      bidIncreaseCap: 0.17, bidDecreaseCap: 0.31, window: { start: '2026-08-01', end: '2026-08-28' } },
    profileTimezone: 'UTC', admittedAt: '2026-09-10T12:00:00Z', profileToday: '2026-09-10' });
  const batchId = randomUUID(), childRunId = randomUUID(), jobId = randomUUID(), recommendationId = randomUUID();
  const keywordId = `synthetic-one-time-${randomUUID()}`;
  const group = (await readOptimizationWorkspace(db, { orgId, profileId })).groups[0]!.group;
  // Fixture-only definer records worker output while retaining its real session guard.
  await db.sql`create function public.synthetic_restore_output(p_row jsonb) returns void
    language sql security definer set search_path=pg_catalog,public as $$
    insert into public.recommendations(id,run_id,org_id,profile_id,reason,entity_type,entity_id,
      campaign_id,ad_group_id,ad_product,field,current_value,proposed_value,inputs,status)
    select id,run_id,org_id,profile_id,reason,entity_type,entity_id,campaign_id,ad_group_id,ad_product,
      field,current_value,proposed_value,inputs,status from jsonb_populate_record(null::public.recommendations,p_row)
    $$`;
  const session = await db.sql.reserve();
  try {
    await session`set session authorization service_role`;
    await session`select public.block_recommendation_admission(0)`;
    await session`select public.activate_recommendation_fenced_claims(1,${'c'.repeat(40)})`;
    await session`select public.authorize_recommendation_scoped_admission(2,${'c'.repeat(40)})`;
    await session`set session authorization openspell_recommendation_worker`;
    await session`select public.report_recommendation_runtime('synthetic-restore-fixture',${'c'.repeat(40)},array[1,2],true)`;
  } finally { await session`reset session authorization`; session.release(); }
  await db.sql.begin(async (sql) => {
    await sql`insert into public.recommendation_preview_batches(id,org_id,profile_id,client_request_id,selection_mode,
      request_fingerprint,scope_count,scope_fingerprint,child_count,created_by,execution_snapshot)
      values(${batchId},${orgId},${profileId},${randomUUID()},'selected',${'a'.repeat(64)},1,
        app.recommendation_batch_scope_fingerprint(${profileId},array['c-1']),1,${userId},${JSON.stringify(snapshot)}::jsonb)`;
    await sql`insert into public.sync_jobs(id,org_id,profile_id,job_type,payload,status,started_at,finished_at)
      values(${jobId},${orgId},${profileId},'recommendations.run',jsonb_build_object('type','recommendations.run',
        'orgId',${orgId}::text,'profileId',${profileId}::text,'runId',${childRunId}::text,'groupId',${group.id}::text,
        'executionVersion',2,'snapshotFingerprint',app.one_time_rpc_snapshot_fingerprint(${JSON.stringify(snapshot)}::jsonb)),
        'succeeded',now(),now())`;
    await sql`insert into public.recommendation_runs(id,org_id,profile_id,batch_id,status,lookback_days,scope_version,
      scope_count,scope_fingerprint,job_id,execution_snapshot,execution_lineage,proposals_count,group_id,group_role,group_snapshot)
      values(${childRunId},${orgId},${profileId},${batchId},'succeeded',28,2,1,
        app.recommendation_run_scope_fingerprint(${profileId},${group.id}::uuid,array['c-1']),${jobId},
        ${JSON.stringify(snapshot)}::jsonb,'queue',1,${group.id},${group.role},${JSON.stringify(group)}::jsonb)`;
    await sql`insert into public.recommendation_run_campaigns(org_id,profile_id,batch_id,run_id,campaign_id)
      values(${orgId},${profileId},${batchId},${childRunId},'c-1')`;
    await sql`insert into public.keywords(org_id,profile_id,amazon_id,ad_product,state,campaign_id,ad_group_id,keyword_text,match_type,bid,synced_at)
      values(${orgId},${profileId},${keywordId},'SP','enabled','c-1','ag-1','Synthetic one-time restore','exact',0.91,clock_timestamp())`;
    await sql`set local session authorization openspell_recommendation_worker`;
    await sql`select public.synthetic_restore_output(${JSON.stringify({ id: recommendationId, run_id: childRunId, org_id: orgId,
      profile_id: profileId, reason: 'high_acos', entity_type: 'keyword', entity_id: keywordId,
      campaign_id: 'c-1', ad_group_id: 'ag-1', ad_product: 'SP', field: 'bid', current_value: 0.91, proposed_value: 0.67,
      inputs: syntheticRecommendationMethodInputs(), status: 'accepted' })}::jsonb)`;
    await sql`reset session authorization`;
  });
  const [run] = await db.sql`select scope_version,strategy_snapshot,strategy_goal,execution_snapshot
    from public.recommendation_runs where id=${childRunId}`;
  expect(run).toEqual({ scope_version: 2, strategy_snapshot: null, strategy_goal: null, execution_snapshot: snapshot });
  const fingerprint = await withAuthenticatedReadSnapshot(db, actor(), tx => readOptimizerExportBinding(tx, { orgId, profileId, batchId }));
  expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
  const exported = await withAuthenticatedOrgEditor(db, actor(), tx => exportOptimizerSelection(tx, {
    requestId: randomUUID(), profileId, batchId, reviewFingerprint: fingerprint!, recommendationIds: [recommendationId] }));
  expect(exported.counts).toEqual({ offered: 1, accepted: 1, exported: 1, applyRows: 1 });
  expect(exported.forwardRowIds).toHaveLength(1);
  await recordEntityChanges(db, [{ orgId, profileId, entityType: 'keyword', amazonId: keywordId, field: 'bid',
    oldValue: 0.91, newValue: 0.67, source: 'sync', observedAt: new Date() }]);
  await db.sql`update public.keywords set bid=0.67,synced_at=clock_timestamp() where org_id=${orgId} and profile_id=${profileId} and amazon_id=${keywordId}`;
  const source = await getReversionBatchPreview(db, { orgId, batchId: exported.applyBatchId });
  expect(source?.rows).toHaveLength(1);
  expect(source?.rows[0]).toMatchObject({ rowId: exported.forwardRowIds[0], state: 'ready', currentValue: 0.67, inverseValue: 0.91 });
  const preview = await withAuthenticatedOrgEditor(db, actor(), tx => buildRestoreProposal(tx, {
    requestId: randomUUID(), profileId, applyBatchId: exported.applyBatchId, sourceRowIds: exported.forwardRowIds }));
  const evidence = preview.evidence;
  if (evidence?.schemaVersion !== 'openspell.sp-write-preview-evidence.v1') throw new Error('Expected recorded restore source evidence');
  expect(evidence.guardrails.policies).toEqual([expect.objectContaining({ strategyGoal: 'one_time', runId: childRunId })]);
  expect(JSON.parse(evidence.guardrails.policies[0]!.strategySnapshotText)).toEqual(snapshot);
  expect(preview.plan.actions).toHaveLength(1);
  expect(preview.plan.actions[0]).toMatchObject({ entity: { keywordId }, changes: { bid: {
    expected: { amount: '0.67' }, requested: { amount: '0.91' } } } });
  const admission = await withAuthenticatedOrgEditor(db, actor(), tx => approveSpWriteForActor(tx, {
    profileId, confirmation: spWriteConfirmation(1), approval: { approvalRequestId: randomUUID(), plan: preview.binding,
      approvalMode: 'manual', confirmationVersion: 'openspell.amazon-sp-write-confirmation.v1', boundedAuthorization: null, preapprovedInversePlan: null } }));
  expect(admission.kind).toBe('queued');
  const [counts] = await db.sql`select
    (select count(*)::int from app.sp_write_forward_admissions where plan_id=${preview.plan.id} and operation_kind='restore') as rows,
    (select count(*)::int from public.sp_write_outbox where plan_id=${preview.plan.id}) as outbox,
    (select count(*)::int from public.sp_write_provider_call_intents where plan_id=${preview.plan.id}) as calls`;
  expect(counts).toEqual({ rows: 1, outbox: 1, calls: 0 });
});
