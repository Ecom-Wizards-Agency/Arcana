import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@wizard-ads/db/testing';
import { persistProductAssignments } from '@wizard-ads/db';
import { GET, POST } from './route';
let db:TestDatabase,orgId:string,profileId:string;
const owner='00000000-0000-4000-8000-000000000011',viewer='00000000-0000-4000-8000-000000000012';
const bridge='synthetic-assignment-route';
const keys=['DATABASE_URL','WIZARD_ADS_E2E_AUTH_BRIDGE','WIZARD_ADS_AUTH_BRIDGE_SECRET'] as const;
const previous=keys.map(key=>process.env[key]);
beforeAll(async()=>{
  db=await createTestDatabase('wp315_route');
  const [org]=await db.sql`select app.seed_tenant_fixture('synthetic-assignment-route',${owner},'owner') as id`;orgId=String(org!['id']);
  const [profile]=await db.sql`select id from public.ad_profiles where org_id=${orgId}`;profileId=String(profile!['id']);
  await db.sql`select public.auth_user_stub(${viewer})`;
  await db.sql`insert into public.org_members(org_id,user_id,role) values(${orgId},${viewer},'viewer')`;
  process.env['DATABASE_URL']=db.connectionString;process.env['WIZARD_ADS_E2E_AUTH_BRIDGE']='1';process.env['WIZARD_ADS_AUTH_BRIDGE_SECRET']=bridge;
},180_000);
afterAll(async()=>{keys.forEach((key,index)=>{if(previous[index]===undefined)delete process.env[key];else process.env[key]=previous[index];});await db?.drop();});
const headers=(userId=owner)=>({'content-type':'application/json','x-wizard-ads-auth-bridge':bridge,'x-wizard-ads-user-id':userId,'x-wizard-ads-org-id':orgId});
const post=(body:unknown,userId=owner)=>POST(new Request('http://localhost/targets/product-assignments',{method:'POST',headers:headers(userId),body:JSON.stringify(body)}));
it('lists all assignments and saves/reverts through the authenticated route',async()=>{
  const response=await GET(new Request(`http://localhost/targets/product-assignments?profileId=${profileId}&start=2026-09-01&end=2026-09-01`,{headers:headers()}));
  expect(response.status).toBe(200);const list=await response.json();expect(list.items).toHaveLength(list.count);expect(list.count).toBe(1);
  expect((await post({action:'assign',profileId,adGroupId:'ag-1',asin:'B0TEST0001'})).status).toBe(200);
  const reverted=await post({action:'revert',profileId,adGroupId:'ag-1'});expect(reverted.status).toBe(200);expect(await reverted.json()).toEqual({assigned:1});
  expect(await db.sql`select source,asin from public.ad_group_product_assignments where org_id=${orgId}`).toEqual([{source:'unassigned',asin:null}]);
});
it('rejects viewers, invalid inputs and stale choices',async()=>{
  expect((await post({action:'assign',profileId,adGroupId:'ag-1',asin:'B0TEST0001'},viewer)).status).toBe(403);
  expect((await post({action:'assign',profileId,adGroupId:'ag-1',asin:'B000000009'})).status).toBe(409);
  expect((await post({action:'assign',profileId,adGroupId:'ag-1',asin:'B0TEST0001',source:'derived'})).status).toBe(400);
});
it('refuses to assign over a derived or derived-parent product with a reason code and writes nothing',async()=>{
  const derive=(source:'derived'|'derived_parent',asin:string,at:string)=>persistProductAssignments(db,{orgId,profileId},
    [{adGroupId:'ag-1',assignedAsin:asin,source,ambiguous:false,reason:null,candidates:[{asin:'B0TEST0001',skus:[],parentAsin:null,spend:null}]}],at);
  for (const [source,asin,at] of [['derived','B0TEST0001','2026-09-10T00:00:00Z'],['derived_parent','B000000099','2026-09-11T00:00:00Z']] as const) {
    await derive(source,asin,at);
    const refused=await post({action:'assign',profileId,adGroupId:'ag-1',asin:'B0TEST0001'});
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({code:'assignment_derived'});
    expect(await db.sql`select source,asin from public.ad_group_product_assignments where org_id=${orgId}`).toEqual([{source,asin}]);
  }
});
