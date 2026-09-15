import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../testing/harness.js';
import { asUser } from '../testing/rls.js';
import { withAuthenticatedOrgEditor, withAuthenticatedReadSnapshot } from './authenticated-actor.js';
import { assignAdGroupProduct, listAdGroupProducts } from './ad-group-products.js';
let database: TestDatabase;
const owner = '00000000-0000-4000-8000-000000000011';
const other = '00000000-0000-4000-8000-000000000012';
const viewer = '00000000-0000-4000-8000-000000000013';
let orgId: string, otherOrgId: string, profileId: string, foreignProfileId: string;
const scope = () => ({ profileId, start: '2026-09-01', end: '2026-09-02' });
const read = () => withAuthenticatedReadSnapshot(database, { orgId, userId: owner }, (context) => listAdGroupProducts(context, scope()));
beforeAll(async () => {
  database = await createTestDatabase('wp272_assignments');
  const [a] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture('synthetic-assignments-a',${owner},'owner') as id`;
  const [b] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture('synthetic-assignments-b',${other},'owner') as id`;
  orgId=a!.id;otherOrgId=b!.id;
  const profiles = await database.sql<{ id: string; org_id: string }[]>`select id,org_id from public.ad_profiles where org_id in (${orgId},${otherOrgId})`;
  profileId=profiles.find((row) => row.org_id===orgId)!.id;foreignProfileId=profiles.find((row) => row.org_id===otherOrgId)!.id;
  await database.sql`delete from public.ad_group_product_assignments where org_id=${orgId}`;
  await database.sql`select public.auth_user_stub(${viewer})`;
  await database.sql`insert into public.org_members(org_id,user_id,role) values(${orgId},${viewer},'viewer'),(${otherOrgId},${owner},'analyst')`;
  await database.sql`insert into public.product_ads(org_id,profile_id,amazon_id,ad_product,state,campaign_id,ad_group_id,asin)
    values(${orgId},${profileId},'synthetic-second','SP','enabled','c-1','ag-1','B000000002'),
    (${orgId},${profileId},'synthetic-duplicate','SP','enabled','c-1','ag-1','B000000002')`;
  await database.sql`insert into public.fact_sp_target_daily(org_id,profile_id,date,campaign_id,ad_group_id,target_id,target_kind,ad_product,cost)
    values(${orgId},${profileId},'2026-09-01','c-1','ag-1','kw-1','keyword','SP',20),
    (${orgId},${profileId},'2026-09-02','c-1','ag-1','kw-1','keyword','SP',30)`;
},180_000);
afterAll(async () => { await database?.drop(); });
it('lists each group once, deduplicates ASINs and reconciles spend without join multiplication', async () => {
  const list=await read();
  expect(list.count).toBe(1);expect(list.items).toHaveLength(1);
  expect(list.items[0]?.asins).toHaveLength(2);expect(list.items[0]?.spend).toBe(50);
  expect(list.unassignedCount).toBe(1);expect(list.unassignedSpend).toBe(50);
});
it('binds assignments to the actor, persists one row and recounts', async () => {
  await withAuthenticatedOrgEditor(database,{orgId,userId:owner},(context) => assignAdGroupProduct(context,{profileId,adGroupId:'ag-1',asin:'B000000002'}));
  const list=await read();expect(list.unassignedCount).toBe(0);expect(list.unassignedSpend).toBe(0);
  expect(await database.sql`select assigned_by,asin from public.ad_group_product_assignments where org_id=${orgId}`).toEqual([{assigned_by:owner,asin:'B000000002'}]);
  await withAuthenticatedOrgEditor(database,{orgId,userId:owner},(context) => assignAdGroupProduct(context,{profileId,adGroupId:'ag-1',asin:'B000000002'}));
  expect(await database.sql`select * from public.ad_group_product_assignments where org_id=${orgId}`).toHaveLength(1);
});
it('refuses viewers, foreign profiles even with dual membership, and forged direct writes', async () => {
  await expect(withAuthenticatedOrgEditor(database,{orgId,userId:viewer},(context) => assignAdGroupProduct(context,{profileId,adGroupId:'ag-1',asin:'B000000002'}))).rejects.toThrow();
  await expect(withAuthenticatedReadSnapshot(database,{orgId,userId:owner},(context) => listAdGroupProducts(context,{...scope(),profileId:foreignProfileId}))).rejects.toThrow();
  await expect(withAuthenticatedOrgEditor(database,{orgId,userId:owner},(context) => assignAdGroupProduct(context,{profileId:foreignProfileId,adGroupId:'ag-1',asin:'B0TEST0001'}))).rejects.toThrow();
  await expect(asUser(database,owner,(sql) => sql`update public.ad_group_product_assignments set assigned_by=${other} where org_id=${orgId}`)).rejects.toThrow();
  const visible=await asUser(database,viewer,(sql) => sql`select * from public.ad_group_product_assignments where org_id=${otherOrgId}`);
  expect(visible).toHaveLength(0);
});
it('refuses stale options and restores unresolved counts when an assignment ceases to be advertised', async () => {
  await expect(withAuthenticatedOrgEditor(database,{orgId,userId:owner},(context) => assignAdGroupProduct(context,{profileId,adGroupId:'ag-1',asin:'B000000009'}))).rejects.toThrow();
  await database.sql`update public.product_ads set deleted_at=now() where org_id=${orgId} and asin='B000000002'`;
  await database.sql`insert into public.product_ads(org_id,profile_id,amazon_id,ad_product,state,campaign_id,ad_group_id,asin)
    values(${orgId},${profileId},'synthetic-third','SP','enabled','c-1','ag-1','B000000003')`;
  const list=await read();expect(list.unassignedCount).toBe(1);expect(list.items[0]?.assignedAsin).toBeNull();
  const missing=await withAuthenticatedReadSnapshot(database,{orgId,userId:owner},(context) => listAdGroupProducts(context,{...scope(),start:'2020-01-01',end:'2020-01-01'}));
  expect(missing.items[0]?.spend).toBeNull();expect(missing.unassignedCount).toBe(0);
});
