import { beforeAll, afterAll, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@wizard-ads/db/testing';
import { PostgresWorkerStore, type EntitySyncCounts, type StoreLogger } from './store.js';
import { refreshProductAssignments } from './product-assignment.js';
import type { ProductAdRow } from '@wizard-ads/shared';
let db:TestDatabase,orgId:string,profileId:string;
const owner='00000000-0000-4000-8000-000000000011';
const [first,second]=['B000000001','B000000002'] as const;
const logged:{message:string;details?:Record<string,unknown>}[]=[];
const logger:StoreLogger={info:(message,details)=>{logged.push(details===undefined?{message}:{message,details});}};
const productAd=(amazonId:string,asin:string):ProductAdRow=>({entityType:'product_ad',profileId,amazonId,adProduct:'SP',state:'paused',name:null,campaignId:'c-1',adGroupId:'ag-1',asin,sku:`synthetic-${asin}`});
const addDays=(date:string,days:number)=>new Date(Date.parse(date)+days*86_400_000).toISOString().slice(0,10);
const assignments=()=>db.sql`select source,asin from public.ad_group_product_assignments where org_id=${orgId}`;
beforeAll(async()=>{
  db=await createTestDatabase('wp315_worker');
  const [org]=await db.sql`select app.seed_tenant_fixture('synthetic-worker-derivation',${owner},'owner') as id`;orgId=String(org!['id']);
  const [profile]=await db.sql`select id from public.ad_profiles where org_id=${orgId}`;profileId=String(profile!['id']);
  await db.sql`delete from public.ad_group_product_assignments where org_id=${orgId}`;
  await db.sql`update public.ad_profiles set timezone='UTC' where id=${profileId}`;
  for (const [month,from,until] of [['202608','2026-08-01','2026-09-01'],['202609','2026-09-01','2026-10-01']] as const) {
    await db.sql.unsafe(`create table if not exists public.fact_advertised_product_daily_${month} partition of public.fact_advertised_product_daily for values from ('${from}') to ('${until}')`);
  }
},180_000);
afterAll(async()=>{await db?.drop();});
const syncOptions=async(store:PostgresWorkerStore)=>({adProduct:'SP' as const,full:true,readStartedAt:(await store.beginEntityRead())!,excludedEntityTypes:['portfolio','campaign','ad_group','keyword','target','negative'] as const});

it('derives after a fake product-ad mirror sync and reports parsed against read-back counts in the sync result',async()=>{
  const store=new PostgresWorkerStore(db,logger),profile=await store.profile(profileId);
  const sync=await store.syncEntities(profile,[productAd('synthetic-new-ad',second)],await syncOptions(store));
  expect(sync.listed).toBe(1);expect(sync.upserted+sync.duplicates).toBe(sync.listed);
  expect(sync.productAssignments).toEqual({status:'refreshed',parsed:1,saved:1,offered:1,changed:1,unchanged:0,manual:0});
  expect(logged.find((entry)=>entry.message==='product assignment refresh')?.details).toMatchObject({profileId,status:'refreshed',parsed:1,saved:1});
  expect(await assignments()).toEqual([{source:'derived',asin:second}]);
  expect(await refreshProductAssignments(db,profile)).toEqual({parsed:1,saved:1,offered:1,changed:0,unchanged:1,manual:0});
  const empty=await store.syncEntities(profile,[],await syncOptions(store));
  expect(empty.productAssignments).toMatchObject({status:'refreshed',parsed:1,saved:1,changed:1});
  expect(await assignments()).toEqual([{source:'unassigned',asin:null}]);
});
it('does not refresh on an excluded product-ad sync',async()=>{
  const store=new PostgresWorkerStore(db,logger),profile=await store.profile(profileId);
  await db.sql`delete from public.ad_group_product_assignments where org_id=${orgId}`;
  const sync=await store.syncEntities(profile,[],{adProduct:'SP',full:false,readStartedAt:(await store.beginEntityRead())!,excludedEntityTypes:['product_ad']});
  expect(sync.productAssignments).toBeUndefined();
  expect(await db.sql`select * from public.ad_group_product_assignments where org_id=${orgId}`).toHaveLength(0);
});
it('keeps the recorded entity changes when the refresh fails, logs the reason, and derives again on the next sync',async()=>{
  const store=new PostgresWorkerStore(db,logger),profile=await store.profile(profileId);
  await db.sql`create function public.synthetic_assignment_conflict() returns trigger language plpgsql as $$
    begin raise exception 'synthetic serialization conflict' using errcode='40001'; end $$`;
  await db.sql`create trigger synthetic_assignment_conflict before insert or update on public.ad_group_product_assignments
    for each row execute function public.synthetic_assignment_conflict()`;
  let failed: EntitySyncCounts | undefined;
  try {
    failed=await store.syncEntities(profile,[productAd('synthetic-conflict-ad',first)],await syncOptions(store));
  } finally {
    await db.sql`drop trigger synthetic_assignment_conflict on public.ad_group_product_assignments`;
    await db.sql`drop function public.synthetic_assignment_conflict()`;
  }
  expect(failed).toMatchObject({listed:1,upserted:1,productAssignments:{status:'failed',reason:'synthetic serialization conflict'}});
  expect(failed!.changes).toBeGreaterThan(0);
  const recorded=await db.sql`select field,source from public.entity_changes where org_id=${orgId} and entity_type='product_ad' and amazon_id='synthetic-conflict-ad'`;
  expect(recorded).toEqual([{field:'entity',source:'sync'}]);
  expect(logged.find((entry)=>entry.message==='product assignment refresh failed; the next sync retries it')?.details).toMatchObject({profileId,status:'failed',reason:'synthetic serialization conflict'});
  expect(await assignments()).toHaveLength(0);
  const retried=await store.syncEntities(profile,[productAd('synthetic-conflict-ad',first)],await syncOptions(store));
  expect(retried.productAssignments).toEqual({status:'refreshed',parsed:1,saved:1,offered:1,changed:1,unchanged:0,manual:0});
  expect(await assignments()).toEqual([{source:'derived',asin:first}]);
});
it('fails the refresh without writing when fewer rows read back than ad groups were parsed',async()=>{
  const store=new PostgresWorkerStore(db,logger),profile=await store.profile(profileId);
  await db.sql`delete from public.ad_group_product_assignments where org_id=${orgId}`;
  await db.sql`create function public.synthetic_assignment_skip() returns trigger language plpgsql as $$ begin return null; end $$`;
  await db.sql`create trigger synthetic_assignment_skip before insert on public.ad_group_product_assignments for each row execute function public.synthetic_assignment_skip()`;
  try {
    await expect(refreshProductAssignments(db,profile)).rejects.toThrow('Assignment refresh parsed 1 ad groups but read back 0');
    const sync=await store.syncEntities(profile,[productAd('synthetic-conflict-ad',first)],await syncOptions(store));
    expect(sync.productAssignments).toEqual({status:'failed',reason:'Assignment refresh parsed 1 ad groups but read back 0'});
  } finally {
    await db.sql`drop trigger synthetic_assignment_skip on public.ad_group_product_assignments`;
    await db.sql`drop function public.synthetic_assignment_skip()`;
  }
  expect(await assignments()).toHaveLength(0);
});
it('proposes the top-spend product under the production report cadence and never flips across the week',async()=>{
  const store=new PostgresWorkerStore(db,logger),profile=await store.profile(profileId);
  await db.sql`delete from public.ad_group_product_assignments where org_id=${orgId}`;
  await store.syncEntities(profile,[productAd('synthetic-first-ad',first),productAd('synthetic-second-ad',second)],await syncOptions(store));
  expect(await assignments()).toEqual([{source:'proposed',asin:first}]);
  // A daily pull of the three previous days and a weekly re-pull of 32 days, promoted as the pipeline promotes them.
  const pull=async(observedOn:string,start:string,end:string)=>{
    const observedAt=`${observedOn}T06:00:00Z`;
    const [request]=await db.sql`insert into public.report_requests(org_id,profile_id,report_type,start_date,end_date,requested_at)
      values(${orgId},${profileId},'spAdvertisedProduct',${start},${end},${observedAt}) returning id`;
    await db.sql`delete from public.fact_advertised_product_daily where org_id=${orgId} and profile_id=${profileId} and date between ${start} and ${end}`;
    await db.sql`insert into public.fact_advertised_product_daily(org_id,profile_id,date,period_end,family,variant,ad_product,dimensions,identity_dimensions,row_data,report_request_id,observed_at)
      select ${orgId}::uuid,${profileId}::uuid,d::date,d::date,'spAdvertisedProduct','DAILY:legacy:v1','SP',jsonb_build_object('adGroupId','ag-1','advertisedAsin',x.asin),
        jsonb_build_object('adId','synthetic-'||x.asin),jsonb_build_object('metrics',jsonb_build_object('cost',x.cost)),${request!['id']}::uuid,${observedAt}::timestamptz
      from generate_series(${start}::date,${end}::date,interval '1 day') d cross join (values (${first},2),(${second},5)) x(asin,cost)`;
    await db.sql`insert into public.report_family_watermarks(org_id,profile_id,family,variant,period_start,period_end,report_request_id,requested_at,observed_at,canonical_rows)
      select ${orgId}::uuid,${profileId}::uuid,'spAdvertisedProduct','DAILY:legacy:v1',d::date,d::date,${request!['id']}::uuid,${observedAt}::timestamptz,${observedAt}::timestamptz,2
      from generate_series(${start}::date,${end}::date,interval '1 day') d
      on conflict(org_id,profile_id,family,variant,period_start,period_end) do update set report_request_id=excluded.report_request_id,
        requested_at=excluded.requested_at,observed_at=excluded.observed_at,canonical_rows=excluded.canonical_rows`;
  };
  const cadence=async(day:string)=>{
    await pull(day,addDays(day,-3),addDays(day,-1));
    if (day==='2026-09-06'||day==='2026-09-13') await pull(day,addDays(day,-32),addDays(day,-1));
  };
  for (let day='2026-08-05';day<='2026-09-13';day=addDays(day,1)) await cadence(day);
  const changed:number[]=[];
  for (let day='2026-09-14';day<='2026-09-19';day=addDays(day,1)) {
    await cadence(day);
    changed.push((await refreshProductAssignments(db,profile,`${day}T12:00:00Z`)).changed);
    const [row]=await db.sql`select source,asin,derivation->>'reason' as reason,derived_at from public.ad_group_product_assignments where org_id=${orgId}`;
    expect(row, day).toMatchObject({source:'proposed',asin:second,reason:'Products do not share a known parent; ranked on 30 of 30 mature days.'});
  }
  // The weekly re-pull landing 1 to 6 days earlier changes nothing: one write, then identical derivations.
  expect(changed).toEqual([1,0,0,0,0,0]);
});
