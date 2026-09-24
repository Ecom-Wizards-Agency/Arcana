import { beforeAll, afterAll, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@wizard-ads/db/testing';
import { PostgresWorkerStore } from '../store.js';
let db:TestDatabase,orgId:string,profileId:string;
beforeAll(async()=>{
  db=await createTestDatabase('own_collector_schedules');
  const [org]=await db.sql<{id:string}[]>`select app.seed_tenant_fixture('synthetic-collector-schedule','00000000-0000-4000-8000-000000000094','owner') as id`;
  orgId=org!.id;
  const [profile]=await db.sql<{id:string}[]>`select id from public.ad_profiles where org_id=${orgId}`;profileId=profile!.id;
},60000);
afterAll(async()=>{await db?.drop();});
it('requires explicit source enablement and reconciles bounded daily schedules',async()=>{
  const off=new PostgresWorkerStore(db);
  // The first pass provisions only the default Creative schedule (variant 'default'), no collector source.
  expect(await off.ensureIntegrationSchedules()).toBe(1);
  expect(await off.ensureIntegrationSchedules()).toBe(0);
  const on=new PostgresWorkerStore(db,undefined,{ownCollectorsEnabled:true});
  expect(await on.ensureIntegrationSchedules()).toBe(1);
  expect(await on.ensureIntegrationSchedules()).toBe(0);
  await db.sql`update public.integration_connections set status='active' where org_id=${orgId} and provider='keepa'`;
  await db.sql`insert into public.collector_export_references(org_id,profile_id,marketplace,family,enabled,object_key) values(${orgId},${profileId},'US','prompts',true,'prompts.json')`;
  expect(await on.ensureIntegrationSchedules()).toBe(3);
  const rows=await db.sql<{type:string;cadence:string}[]>`select job_type::text as type,cadence::text from public.sync_schedules where profile_id=${profileId} and variant='integration' and enabled order by job_type::text`;
  expect(rows).toEqual(['keepa.sync','own_bids.collect','own_listings.collect','prompts.collect'].map((type)=>({type,cadence:'1 day'})));
  expect(await off.ensureIntegrationSchedules()).toBe(3);
  const active=await db.sql<{type:string}[]>`select job_type::text as type from public.sync_schedules where profile_id=${profileId} and variant='integration' and enabled`;
  expect(active).toEqual([{type:'keepa.sync'}]);
});
