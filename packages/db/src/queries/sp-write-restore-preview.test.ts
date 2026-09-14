import { createHash, randomUUID } from 'node:crypto';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { spWriteRestoreProposals, spWriteRestoreReviews } from '../schema/restore-proposals.js';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { COORDINATED_RESTORE_UNAVAILABLE, serializeApplyRows, type ApplyRow } from '@wizard-ads/shared';
import { SpWritePreview } from '@wizard-ads/shared/sp-write-application';
import { spWritePlanBinding } from '@wizard-ads/shared/sp-writes';
import { createTestDatabase, type TestDatabase } from '../testing/harness.js';
import { withAuthenticatedOrgEditor, withAuthenticatedActor } from './authenticated-actor.js';
import { buildRestoreProposal, readRestoreProposal, recordRestoreProposal, reviewRestoreProposal } from './sp-write-restore-preview.js';
import { buildSpWriteLegacyPreview } from './sp-write-plan-builder.js';
import { getReversionBatchPreview, listChangeQueue } from './time-machine.js';
import { recordEntityChanges } from './entities.js';
import { createRequestDatabase } from './request-client.js';
let db:TestDatabase, orgId:string,profileId:string,runId:string,otherOrg:string;
const userId=randomUUID(),otherUser=randomUUID();
const actor=()=>({orgId,userId});
beforeAll(async()=>{
  db=await createTestDatabase('restore_proposals');
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
async function fixture() {
  const batchId=randomUUID(),rowIds=Array.from({length:7},()=>randomUUID()), prefix=randomUUID();
  const entities=rowIds.map((_,i)=>`${prefix}-${i}`);
  const artifactRows:ApplyRow[]=entities.map((entityId,i)=>({entityType:'keyword',entityId,field:i===5?'placement':'bid',old:1,new:2}));
  const hash=createHash('sha256').update(serializeApplyRows(artifactRows)).digest('hex');
  await db.sql`insert into public.apply_batches(id,org_id,profile_id,tag,opt_group,lever,note,exported_at,exported_proposals,reversible_rows,unsupported_rows,artifact_sha256)
    values(${batchId},${orgId},${profileId},${batchId},'synthetic','bid','Synthetic restore evidence',now()-interval '1 hour',7,7,0,${hash})`;
  for(const [i,rowId] of rowIds.entries()) {
    const rec=randomUUID(),entity=entities[i]!;
    await db.sql`insert into public.keywords(org_id,profile_id,amazon_id,ad_product,state,campaign_id,ad_group_id,keyword_text,match_type,bid,synced_at)
      values(${orgId},${profileId},${entity},'SP','enabled','c-1','ag-1','Synthetic restore','exact',${i===2?3:i===3?1:i===4?4:2},case when ${i===6} then now()-interval '2 hours' else now() end)`;
    await db.sql`insert into public.recommendations(id,run_id,org_id,profile_id,reason,entity_type,entity_id,field,current_value,proposed_value,inputs)
      values(${rec},${runId},${orgId},${profileId},'high_acos','keyword',${entity},${i===5?'placement':'bid'},'1','2','{}')`;
    await db.sql`insert into public.apply_rows(id,batch_id,org_id,profile_id,recommendation_id,entity_type,entity_id,field,old_value,new_value)
      values(${rowId},${batchId},${orgId},${profileId},${rec},'keyword',${entity},${i===5?'placement':'bid'},'1','2')`;
    await db.sql`update public.recommendations set status='exported',export_batch_id=${batchId} where id=${rec}`;
  }
  await recordEntityChanges(db,entities.slice(0,5).map(amazonId=>({orgId,profileId,entityType:'keyword' as const,amazonId,field:'bid',oldValue:1,newValue:2,source:'sync' as const,observedAt:new Date()})));
  return {batchId,rowIds,entities,request:{requestId:randomUUID(),profileId,applyBatchId:batchId,sourceRowIds:rowIds.slice(0,2)}};
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
  const queued=await listChangeQueue(db,{orgId,profileId,source:'restore'});expect(queued).toHaveLength(1);expect(queued[0]).toMatchObject({state:'awaiting review',reviewHref:expect.stringContaining(f.request.requestId)});
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
  await expect(withAuthenticatedOrgEditor(db,actor(),tx=>buildRestoreProposal(tx,{...f.request,sourceRowIds:f.rowIds.slice(0,3)}))).rejects.toThrow('selection changed');
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
