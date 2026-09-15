import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { serializeApplyRows } from '@wizard-ads/shared';
import { spWriteRestoreExportConfirmation } from '@wizard-ads/shared/sp-write-application';
import { createTestDatabase, type TestDatabase } from '../testing/harness.js';
import { withAuthenticatedOrgEditor } from './authenticated-actor.js';
import { recordEntityChanges } from './entities.js';
import { exportRestoreProposalForActor, readRestoreExportPreview, restoreProfileWriteEnabled } from './sp-write-restore-export.js';

let database: TestDatabase, orgId: string, profileId: string;
const userId=randomUUID();
const actor=()=>({userId,orgId});
beforeAll(async()=>{
  database=await createTestDatabase('restore_export_fallback');
  const [tenant]=await database.sql<{id:string}[]>`select app.seed_tenant_fixture('synthetic-restore-export',${userId},'owner') as id`;
  orgId=tenant!.id;
  const [profile]=await database.sql<{id:string}[]>`select id from public.ad_profiles where org_id=${orgId}`;
  profileId=profile!.id;
},180000);
afterAll(async()=>{await database?.drop();});

async function fixture() {
  const batchId=randomUUID(),entityId=`synthetic-${randomUUID()}`;
  const artifactSha256=createHash('sha256').update(serializeApplyRows([
    {entityType:'keyword',entityId,field:'bid',old:1,new:2},
  ])).digest('hex');
  await database.sql`insert into public.keywords(org_id,profile_id,amazon_id,ad_product,state,campaign_id,ad_group_id,keyword_text,match_type,bid,synced_at)
    values(${orgId},${profileId},${entityId},'SP','enabled','c-1','ag-1','Synthetic export','exact',2,now())`;
  await database.sql`insert into public.apply_batches(id,org_id,profile_id,tag,opt_group,lever,note,exported_at,exported_proposals,reversible_rows,unsupported_rows,artifact_sha256)
    values(${batchId},${orgId},${profileId},${batchId},'synthetic','bid','Synthetic export fallback',now()-interval '1 hour',1,1,0,${artifactSha256})`;
  await database.sql`insert into public.apply_rows(batch_id,org_id,profile_id,entity_type,entity_id,field,old_value,new_value)
    values(${batchId},${orgId},${profileId},'keyword',${entityId},'bid','1','2')`;
  await recordEntityChanges(database,[{orgId,profileId,entityType:'keyword',amazonId:entityId,field:'bid',oldValue:1,newValue:2,source:'sync'}]);
  await database.sql`update public.keywords set synced_at=clock_timestamp() where org_id=${orgId} and amazon_id=${entityId}`;
  const saved=await withAuthenticatedOrgEditor(database,actor(),context=>readRestoreExportPreview(context,{profileId,batchId}));
  const request={profileId,batchId,fingerprint:saved.fingerprint,expectedRows:1,note:'Synthetic restore export',confirmation:spWriteRestoreExportConfirmation(1)};
  return {batchId,entityId,saved,request};
}

it('exports one exact inverse with its source link and audit while creating no execution authority',async()=>{
  const f=await fixture();
  expect(f.saved.kind).toBe('export_only');
  expect(f.saved.preview.rows).toHaveLength(1);
  expect(await withAuthenticatedOrgEditor(database,actor(),context=>restoreProfileWriteEnabled(context,profileId))).toBe(false);
  const result=await withAuthenticatedOrgEditor(database,actor(),context=>exportRestoreProposalForActor(context,f.request,`synthetic-${randomUUID()}`));
  expect(result.sourceBatchId).toBe(f.batchId);
  expect(result.rows).toEqual([{entityType:'keyword',entityId:f.entityId,field:'bid',old:2,new:1}]);
  expect(createHash('sha256').update(serializeApplyRows(result.rows)).digest('hex')).toBe(result.artifactSha256);
  const [counts]=await database.sql`select
    (select count(*)::int from public.apply_batches where org_id=${orgId} and source_batch_id=${f.batchId}) as batches,
    (select count(*)::int from public.apply_rows where org_id=${orgId} and batch_id=${result.batchId}) as rows,
    (select count(*)::int from public.audit_log where org_id=${orgId} and action='reversion.exported' and target_id=${result.batchId}) as audits,
    (select count(*)::int from public.sp_write_plans where org_id=${orgId} and artifact#>>'{source,applyBatchId}'=${f.batchId}) as plans,
    (select count(*)::int from public.sp_write_execution_requests e join public.sp_write_plans p using(org_id,profile_id,plan_id)
      where e.org_id=${orgId} and p.artifact#>>'{source,applyBatchId}'=${f.batchId}) as queued,
    (select count(*)::int from public.sp_write_provider_call_intents e join public.sp_write_plans p using(org_id,profile_id,plan_id)
      where e.org_id=${orgId} and p.artifact#>>'{source,applyBatchId}'=${f.batchId}) as calls`;
  expect(counts).toEqual({batches:1,rows:1,audits:1,plans:0,queued:0,calls:0});
});

it('refuses moved mirror values, stale read times and changed row counts before export',async()=>{
  const f=await fixture();
  await expect(withAuthenticatedOrgEditor(database,actor(),context=>exportRestoreProposalForActor(context,
    {...f.request,expectedRows:2,confirmation:spWriteRestoreExportConfirmation(2)},'synthetic-stale-count'))).rejects.toMatchObject({code:'source_changed'});
  await database.sql`update public.keywords set bid=3,synced_at=clock_timestamp() where org_id=${orgId} and amazon_id=${f.entityId}`;
  await expect(withAuthenticatedOrgEditor(database,actor(),context=>exportRestoreProposalForActor(context,f.request,'synthetic-stale-value'))).rejects.toMatchObject({code:'source_changed'});
  await database.sql`update public.keywords set bid=2,synced_at=clock_timestamp() where org_id=${orgId} and amazon_id=${f.entityId}`;
  await expect(withAuthenticatedOrgEditor(database,actor(),context=>exportRestoreProposalForActor(context,f.request,'synthetic-stale-read'))).rejects.toMatchObject({code:'source_changed'});
  const [count]=await database.sql`select count(*)::int as n from public.apply_batches where source_batch_id=${f.batchId}`;
  expect(count?.n).toBe(0);
});

it('refuses a sync timestamp changed while export waits for the current mirror lock', async () => {
  const f=await fixture();
  let pending: Promise<{kind:'exported';result:unknown}|{kind:'refused';error:unknown}> | undefined;
  await database.sql.begin(async blocker=>{
    // The new sync remains invisible to the export's initial read until this transaction commits.
    await blocker`update public.keywords set synced_at=clock_timestamp() where org_id=${orgId} and amazon_id=${f.entityId}`;
    pending=withAuthenticatedOrgEditor(database,actor(),context=>exportRestoreProposalForActor(context,f.request,'synthetic-racing-sync'))
      .then(result=>({kind:'exported' as const,result}),error=>({kind:'refused' as const,error}));
    const deadline=Date.now()+5_000;
    let mirrorLockPending=false;
    while(Date.now()<deadline) {
      const [activity]=await database.sql<{waiting:boolean}[]>`select exists(select 1 from pg_stat_activity
        where datname=current_database() and wait_event_type='Lock' and query like '%lock_review_export_rows%') as waiting`;
      if(activity?.waiting) {mirrorLockPending=true;break;}
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    expect(mirrorLockPending).toBe(true);
  });
  if(!pending) throw new Error('Export attempt did not start');
  const outcome=await pending;
  expect(outcome).toMatchObject({kind:'refused',error:{code:'source_changed'}});
  const current=await withAuthenticatedOrgEditor(database,actor(),context=>readRestoreExportPreview(context,{profileId,batchId:f.batchId}));
  expect(current.fingerprint).not.toBe(f.request.fingerprint);
  const [count]=await database.sql`select count(*)::int as n from public.apply_batches where source_batch_id=${f.batchId}`;
  expect(count?.n).toBe(0);
},20_000);

it('requires owner/admin membership and refuses a write-enabled profile as an export-only preview',async()=>{
  const f=await fixture(),analyst=randomUUID();
  await database.sql`select public.auth_user_stub(${analyst})`;
  await database.sql`insert into public.org_members(org_id,user_id,role) values(${orgId},${analyst},'analyst')`;
  await expect(withAuthenticatedOrgEditor(database,{orgId,userId:analyst},context=>readRestoreExportPreview(context,{profileId,batchId:f.batchId}))).rejects.toMatchObject({code:'not_found'});
  const version=randomUUID();
  await database.sql`insert into public.sp_write_profile_grant_versions(grant_id,version_id,org_id,profile_id,enabled,amazon_profile_id,connection_id,region,marketplace_id,currency_code,api_dialect,created_by)
    select g.grant_id,${version},g.org_id,g.profile_id,true,g.amazon_profile_id,g.connection_id,g.region,g.marketplace_id,g.currency_code,g.api_dialect,g.created_by
    from public.sp_write_profile_grant_versions g join public.sp_write_profile_grant_heads h on h.version_id=g.version_id where h.org_id=${orgId} and h.profile_id=${profileId}`;
  await database.sql`update public.sp_write_profile_grant_heads set version_id=${version} where org_id=${orgId} and profile_id=${profileId}`;
  await expect(withAuthenticatedOrgEditor(database,actor(),context=>readRestoreExportPreview(context,{profileId,batchId:f.batchId}))).rejects.toMatchObject({code:'authorization_refused'});
});
