import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../testing/harness.js';
import { asUser } from '../testing/rls.js';
import { AgencyAccessDenied, withAuthenticatedOrgEditor, withAuthenticatedReadSnapshot } from './authenticated-actor.js';
import { listProductAssignments, mutateProductAssignment, persistProductAssignments, ProductAssignmentRefused, readProductAssignmentEvidence } from './product-assignment.js';
import type { ProductAssignmentDerivation } from '@wizard-ads/shared';
let db: TestDatabase, orgId: string, profileId: string;
const owner='00000000-0000-4000-8000-000000000011', viewer='00000000-0000-4000-8000-000000000012';
const [first, second] = ['B0TEST0001', 'B0TEST0002'] as const;
const scope=()=>({orgId,profileId});
const result = (asin: string = first, source: ProductAssignmentDerivation['source'] = 'derived'): ProductAssignmentDerivation => ({
  adGroupId: 'ag-1', assignedAsin: asin, source, ambiguous: source === 'proposed', reason: source === 'proposed' ? 'Synthetic reason.' : null,
  candidates: [{ asin, parentAsin: null, skus: [], spend: null }],
});
const read=()=>withAuthenticatedReadSnapshot(db,{orgId,userId:owner},ctx=>listProductAssignments(ctx,{profileId,start:'2026-09-01',end:'2026-09-01'}));
const assign=(asin: string, userId=owner)=>withAuthenticatedOrgEditor(db,{orgId,userId},ctx=>mutateProductAssignment(ctx,{action:'assign',profileId,adGroupId:'ag-1',asin}));
const revert=()=>withAuthenticatedOrgEditor(db,{orgId,userId:owner},ctx=>mutateProductAssignment(ctx,{action:'revert',profileId,adGroupId:'ag-1'}));
const addDays=(date: string, days: number)=>new Date(Date.parse(date)+days*86_400_000).toISOString().slice(0,10);
const load=(now: string)=>readProductAssignmentEvidence(db,scope(),now);
/** Clears every advertised-product report day so each maturity test states its own history. */
const clearReports=async()=>{
  await db.sql`delete from public.fact_advertised_product_daily where org_id=${orgId}`;
  await db.sql`delete from public.report_family_watermarks where org_id=${orgId}`;
  await db.sql`delete from public.report_coverage where org_id=${orgId} and report_type='spAdvertisedProduct'`;
};
/**
 * One provider pull, promoted the way the report pipeline promotes it: each
 * covered day's facts are replaced and its watermark names this pull.
 */
const pull=async(observedOn: string, start: string, end: string, daily: Record<string, number>)=>{
  const observedAt=`${observedOn}T06:00:00Z`;
  const [request]=await db.sql`insert into public.report_requests(org_id,profile_id,report_type,start_date,end_date,requested_at)
    values(${orgId},${profileId},'spAdvertisedProduct',${start},${end},${observedAt}) returning id`;
  const products=JSON.stringify(Object.entries(daily).map(([asin,cost])=>({asin,cost})));
  await db.sql`delete from public.fact_advertised_product_daily where org_id=${orgId} and profile_id=${profileId}
    and family='spAdvertisedProduct' and variant='DAILY:legacy:v1' and date between ${start} and ${end} and period_end=date`;
  await db.sql`insert into public.fact_advertised_product_daily(org_id,profile_id,date,period_end,family,variant,ad_product,dimensions,identity_dimensions,row_data,report_request_id,observed_at)
    select ${orgId}::uuid,${profileId}::uuid,d::date,d::date,'spAdvertisedProduct','DAILY:legacy:v1','SP',
      jsonb_build_object('adGroupId','ag-1','advertisedAsin',x->>'asin'),jsonb_build_object('adId','synthetic-'||(x->>'asin')),
      jsonb_build_object('metrics',jsonb_build_object('cost',(x->>'cost')::numeric)),${request!['id']}::uuid,${observedAt}::timestamptz
    from generate_series(${start}::date,${end}::date,interval '1 day') d cross join jsonb_array_elements(${products}::jsonb) x`;
  await db.sql`insert into public.report_family_watermarks(org_id,profile_id,family,variant,period_start,period_end,report_request_id,requested_at,observed_at,canonical_rows)
    select ${orgId}::uuid,${profileId}::uuid,'spAdvertisedProduct','DAILY:legacy:v1',d::date,d::date,${request!['id']}::uuid,${observedAt}::timestamptz,${observedAt}::timestamptz,${Object.keys(daily).length}
    from generate_series(${start}::date,${end}::date,interval '1 day') d
    on conflict(org_id,profile_id,family,variant,period_start,period_end) do update set report_request_id=excluded.report_request_id,
      requested_at=excluded.requested_at,observed_at=excluded.observed_at,canonical_rows=excluded.canonical_rows`;
};
/** The production cadence: a daily pull of the three previous days, and a weekly re-pull of 32 days. */
const cadence=async(day: string, daily: Record<string, number>, weekly: readonly string[])=>{
  await pull(day,addDays(day,-3),addDays(day,-1),daily);
  if (weekly.includes(day)) await pull(day,addDays(day,-32),addDays(day,-1),daily);
};
beforeAll(async()=>{
  db=await createTestDatabase('wp315_assignment');
  const [org]=await db.sql`select app.seed_tenant_fixture('synthetic-derivation',${owner},'owner') as id`;orgId=String(org!['id']);
  const [profile]=await db.sql`select id from public.ad_profiles where org_id=${orgId}`;profileId=String(profile!['id']);
  await db.sql`delete from public.ad_group_product_assignments where org_id=${orgId}`;
  await db.sql`select public.auth_user_stub(${viewer})`;
  await db.sql`insert into public.org_members(org_id,user_id,role) values(${orgId},${viewer},'viewer')`;
  await db.sql`update public.ad_profiles set timezone='UTC' where id=${profileId}`;
  for (const month of ['202608','202609']) {
    const from=`${month.slice(0,4)}-${month.slice(4)}-01`, until=month==='202608'?'2026-09-01':'2026-10-01';
    await db.sql.unsafe(`create table if not exists public.fact_advertised_product_daily_${month} partition of public.fact_advertised_product_daily for values from ('${from}') to ('${until}')`);
  }
},180_000);
afterAll(async()=>{await db?.drop();});
it('loads every SP group and lists a group awaiting its first derivation without counting it as unresolved',async()=>{
  const evidence=await load('2026-09-16T00:00:00Z');
  expect(evidence).toHaveLength(1);expect(evidence[0]?.ads).toHaveLength(1);
  const list=await read();expect(list.count).toBe(1);
  expect(list.items[0]).toMatchObject({source:'unassigned',derived:null,derivedAt:null,reason:null});
  expect(list.unassignedCount).toBe(0);
});
it('persists exactly one row, reads it back, and leaves derived-at unchanged on identical refresh',async()=>{
  expect(await persistProductAssignments(db,scope(),[result()],'2026-09-01T00:00:00Z')).toEqual({offered:1,saved:1,changed:1,unchanged:0,manual:0});
  expect(await persistProductAssignments(db,scope(),[result()],'2026-09-02T00:00:00Z')).toEqual({offered:1,saved:1,changed:0,unchanged:1,manual:0});
  const list=await read();expect(list.items[0]).toMatchObject({source:'derived',derivedAt:'2026-09-01T00:00:00.000Z'});expect(list.unassignedCount).toBe(0);
});
it('refuses to assign over a derived or derived-parent product and writes nothing',async()=>{
  await expect(assign(first)).rejects.toMatchObject({name:'ProductAssignmentRefused',code:'assignment_derived'});
  await persistProductAssignments(db,scope(),[result('B000000099','derived_parent')],'2026-09-02T12:00:00Z');
  await expect(assign(first)).rejects.toBeInstanceOf(ProductAssignmentRefused);
  expect(await db.sql`select source,asin from public.ad_group_product_assignments where org_id=${orgId}`).toEqual([{source:'derived_parent',asin:'B000000099'}]);
  await persistProductAssignments(db,scope(),[result(first,'proposed')],'2026-09-02T13:00:00Z');
  await assign(first);
  expect((await read()).items[0]).toMatchObject({source:'manual',assignedAsin:first});
  await revert();
  expect((await read()).items[0]).toMatchObject({source:'proposed',assignedAsin:first});
});
it('preserves manual choices while refreshing the baseline and reverts to that baseline',async()=>{
  await assign(first);
  const parent=result('B000000099','derived_parent');
  expect(await persistProductAssignments(db,scope(),[parent],'2026-09-03T00:00:00Z')).toMatchObject({offered:1,saved:1,changed:1,manual:1});
  expect((await read()).items[0]).toMatchObject({source:'manual',assignedAsin:first,derived:{asin:'B000000099',source:'derived_parent'}});
  await revert();
  expect((await read()).items[0]).toMatchObject({source:'derived_parent',assignedAsin:'B000000099'});
});
it('rejects viewers, foreign profiles and direct provenance forgery and isolates foreign tenants',async()=>{
  await expect(assign(first,viewer)).rejects.toThrow();
  await expect(asUser(db,owner,sql=>sql`update public.ad_group_product_assignments set source='derived',asin='B000000008',assigned_by=${owner} where org_id=${orgId}`)).rejects.toThrow();
  await expect(asUser(db,owner,sql=>sql`update public.ad_group_product_assignments set derivation='{}'::jsonb,assigned_by=${owner} where org_id=${orgId}`)).rejects.toThrow();
  const stranger='00000000-0000-4000-8000-000000000013';
  const [foreign]=await db.sql`select app.seed_tenant_fixture('synthetic-foreign-derivation',${stranger},'owner') as id`;
  const [foreignProfile]=await db.sql`select id from public.ad_profiles where org_id=${String(foreign!['id'])}`;
  // A member of both agencies still acts only inside the active one.
  await db.sql`insert into public.org_members(org_id,user_id,role) values(${String(foreign!['id'])},${owner},'owner')`;
  await expect(withAuthenticatedReadSnapshot(db,{orgId,userId:owner},ctx=>listProductAssignments(ctx,{profileId:String(foreignProfile!['id']),start:'2026-09-01',end:'2026-09-01'}))).rejects.toBeInstanceOf(AgencyAccessDenied);
  await expect(withAuthenticatedOrgEditor(db,{orgId,userId:owner},ctx=>mutateProductAssignment(ctx,{action:'assign',profileId:String(foreignProfile!['id']),adGroupId:'ag-1',asin:first}))).rejects.toBeInstanceOf(AgencyAccessDenied);
  expect(await asUser(db,stranger,sql=>sql`select * from public.ad_group_product_assignments where org_id=${orgId}`)).toHaveLength(0);
});
it('refreshes to unassigned and preserves stale manual rows',async()=>{
  await persistProductAssignments(db,scope(),[result(first,'proposed')],'2026-09-03T12:00:00Z');
  await assign(first);
  await db.sql`update public.product_ads set state='archived' where org_id=${orgId}`;
  const empty:ProductAssignmentDerivation={adGroupId:'ag-1',assignedAsin:null,source:'unassigned',ambiguous:false,reason:'No enabled or paused product ads.',candidates:[]};
  await persistProductAssignments(db,scope(),[empty],'2026-09-04T00:00:00Z');
  expect((await read()).items[0]?.source).toBe('manual');
  await revert();
  expect((await read()).unassignedCount).toBe(1);
  expect((await read()).items[0]?.assignedAsin).toBeNull();
  await db.sql`update public.product_ads set state='enabled' where org_id=${orgId}`;
});
it('reports a readback shortfall to the caller instead of hiding it',async()=>{
  await db.sql`create function public.synthetic_skip_assignment() returns trigger language plpgsql as $$ begin return null; end $$`;
  await db.sql`create trigger synthetic_skip_assignment before update on public.ad_group_product_assignments for each row execute function public.synthetic_skip_assignment()`;
  await db.sql`delete from public.ad_group_product_assignments where org_id=${orgId}`;
  try {
    await db.sql`create trigger synthetic_skip_assignment_insert before insert on public.ad_group_product_assignments for each row execute function public.synthetic_skip_assignment()`;
    expect(await persistProductAssignments(db,scope(),[result()],'2026-09-05T00:00:00Z')).toMatchObject({offered:1,saved:0});
  } finally {
    await db.sql`drop trigger if exists synthetic_skip_assignment_insert on public.ad_group_product_assignments`;
    await db.sql`drop trigger synthetic_skip_assignment on public.ad_group_product_assignments`;
    await db.sql`drop function public.synthetic_skip_assignment()`;
  }
});
it('counts reconciled days by date up to local today minus 7 or the settled date, whenever they were observed',async()=>{
  await clearReports();
  // Every day of the window was pulled early, one day after its date.
  for (let day='2026-08-11';day<='2026-09-10';day=addDays(day,1)) await pull(addDays(day,1),day,day,{[first]:2});
  const now='2026-09-16T12:00:00Z';
  expect((await load(now))[0]).toMatchObject({matureDays:30,windowDays:30,spend:[{asin:first,spend:60}]});
  // A day whose loaded rows no longer reconcile with its watermark is not counted.
  await db.sql`delete from public.fact_advertised_product_daily where org_id=${orgId} and date='2026-09-09'`;
  expect((await load(now))[0]).toMatchObject({matureDays:29,spend:[{asin:first,spend:58}]});
  // An observation after the evidence time does not exist yet.
  await db.sql`update public.report_family_watermarks set observed_at='2026-09-17T00:00:00Z' where org_id=${orgId} and period_end='2026-09-08'`;
  expect((await load(now))[0]?.matureDays).toBe(28);
  // A settled date from report coverage moves the cutoff: 2026-08-07 to 2026-09-05 holds 26 pulled days.
  await db.sql`insert into public.report_coverage(org_id,profile_id,report_type,grain,source,latest_loaded_date,latest_settled_date)
    values(${orgId},${profileId},'spAdvertisedProduct','advertised_product:DAILY:legacy:v1','amazon_reporting_v3','2026-09-10','2026-09-05')`;
  expect((await load(now))[0]).toMatchObject({matureDays:26,spend:[{asin:first,spend:52}]});
  // Without a single mature day there is no spend to rank on.
  await clearReports();
  expect((await load(now))[0]).toMatchObject({matureDays:0,spend:[]});
});
it('measures spend under the production cadence on each of the six days after a weekly re-pull, with the top spender unchanged',async()=>{
  await clearReports();
  await db.sql`insert into public.product_ads(org_id,profile_id,amazon_id,ad_product,state,campaign_id,ad_group_id,asin) values(${orgId},${profileId},'synthetic-second-ad','SP','enabled','c-1','ag-1',${second})`;
  try {
    const daily={[first]:2,[second]:5}, weekly=['2026-09-06','2026-09-13'];
    for (let day='2026-08-05';day<='2026-09-13';day=addDays(day,1)) await cadence(day,daily,weekly);
    const seen=new Set<string>();
    for (let day='2026-09-14';day<='2026-09-19';day=addDays(day,1)) {
      await cadence(day,daily,weekly);
      const [evidence]=await load(`${day}T12:00:00Z`);
      expect(evidence, day).toMatchObject({matureDays:30,windowDays:30});
      const spend=[...evidence!.spend].sort((a,b)=>b.spend-a.spend||a.asin.localeCompare(b.asin));
      expect(spend, day).toEqual([{asin:second,spend:150},{asin:first,spend:60}]);
      seen.add(JSON.stringify({...evidence,spend}));
    }
    // Flip-free inputs: the same measured evidence whatever day the weekly re-pull landed.
    expect(seen.size).toBe(1);
  } finally {
    await db.sql`delete from public.product_ads where org_id=${orgId} and amazon_id='synthetic-second-ad'`;
  }
});
it('reads the same evidence from the same inputs on consecutive days',async()=>{
  // No pull lands between the two reads; only the calendar moves.
  const today=await load('2026-09-19T12:00:00Z');
  const tomorrow=await load('2026-09-20T12:00:00Z');
  expect(today[0]).toMatchObject({matureDays:30,spend:[{asin:first,spend:60}]});
  expect(tomorrow).toEqual(today);
});
it('resolves the newest parent in the bound seller marketplace and refuses conflicting newest observations',async()=>{
  await db.sql`update public.spapi_connections set status='active' where org_id=${orgId}`;
  await db.sql`update public.spapi_profile_bindings set enabled=true where org_id=${orgId}`;
  const [binding]=await db.sql`select b.connection_id,b.marketplace_id,c.selling_partner_id from public.spapi_profile_bindings b join public.spapi_connections c on c.org_id=b.org_id and c.id=b.connection_id where b.org_id=${orgId} and b.profile_id=${profileId}`;
  const add=async(rowKey:string,date:string,parentAsin:string|null)=>db.sql`insert into public.fact_retail_sales_traffic_daily(org_id,selling_partner_id,marketplace_id,date,row_key,profile_id,connection_id,grain,observed_at,report_request_id,payload)
    values(${orgId},${binding!['selling_partner_id']},${binding!['marketplace_id']},${date},${rowKey},${profileId},${binding!['connection_id']},'child',${date}::timestamptz,'fixture-spapi-retail',${JSON.stringify({asin:first,parentAsin})}::jsonb)`;
  await add('synthetic-old-parent','2026-09-01','B000000098');
  await add('synthetic-current-parent','2026-09-02','B000000099');
  const parentAt=()=>load('2026-09-16T12:00:00Z').then((evidence)=>evidence[0]?.ads[0]?.parentAsin);
  expect(await parentAt()).toBe('B000000099');
  await add('synthetic-conflicting-parent','2026-09-02','B000000097');
  expect(await parentAt()).toBeNull();
  await add('synthetic-latest-unknown','2026-09-03',null);
  expect(await parentAt()).toBeNull();
});
