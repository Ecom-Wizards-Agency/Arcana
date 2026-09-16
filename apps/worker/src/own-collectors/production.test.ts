import { beforeAll, afterAll, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTestDatabase, type TestDatabase } from '@wizard-ads/db/testing';
import { upsertReportCoverage, type ClaimedJob } from '@wizard-ads/db';
import { CollectorReceipt, CollectorRefusal, type CollectorScope, type JobPayload } from '@wizard-ads/shared';
import { IngestionRegistry } from '../ingestion-registry.js';
import { PostgresWorkerStore } from '../store.js';
import { SyncWorker } from '../worker.js';
import { postgresOwnCollectors, registerOwnCollectors } from './index.js';

let db: TestDatabase, scope: CollectorScope, root: string;
const at = '2026-06-02T01:00:00.000Z', collectedAt = '2026-06-02T02:00:00.000Z';
const types = ['own_bids.collect', 'own_listings.collect', 'prompts.collect'] as const;
beforeAll(async () => {
  db = await createTestDatabase('own_collector_production');
  root = await mkdtemp(join(tmpdir(), 'own-collector-exports-'));
  const [org] = await db.sql<{id:string}[]>`select app.seed_tenant_fixture('synthetic-collector-production','00000000-0000-4000-8000-000000000095','owner') as id`;
  const [profile] = await db.sql<{id:string}[]>`insert into public.ad_profiles(org_id,amazon_profile_id,region,country_code,currency_code,timezone,sync_enabled)
    values(${org!.id},'synthetic-collector-profile','NA','US','USD','UTC',true) returning id`;
  scope = { orgId: org!.id, profileId: profile!.id, marketplace: 'US' };
  await db.sql`insert into public.campaigns(org_id,profile_id,amazon_id,ad_product,state,name,budget_amount,budget_type) values(${scope.orgId},${scope.profileId},'own-c','SP','enabled','Synthetic own campaign',10,'daily')`;
  await db.sql`insert into public.ad_groups(org_id,profile_id,amazon_id,campaign_id,ad_product,state,name) values(${scope.orgId},${scope.profileId},'own-g','own-c','SP','enabled','Synthetic own group')`;
  await db.sql`insert into public.keywords(org_id,profile_id,amazon_id,campaign_id,ad_group_id,ad_product,state,keyword_text,match_type,bid,synced_at)
    values(${scope.orgId},${scope.profileId},'own-k','own-c','own-g','SP','enabled','synthetic','exact',2,${at})`;
  await db.sql`insert into public.product_ads(org_id,profile_id,amazon_id,campaign_id,ad_group_id,ad_product,state,asin)
    values(${scope.orgId},${scope.profileId},'own-ad','own-c','own-g','SP','enabled','B000000001')`;
  await db.sql`insert into public.collector_export_references(org_id,profile_id,marketplace,family,enabled,object_key)
    values(${scope.orgId},${scope.profileId},'US','listing',true,'listing.json'),(${scope.orgId},${scope.profileId},'US','prompts',true,'prompts.json')`;
  await writeFile(join(root,'listing.json'),JSON.stringify({ scope, rows: [{ scope, asin:'B000000001', sourceIdentity:'own-listing',collectedAt,
    fields:[{field:'price',value:12,provenance:{source:'synthetic-export',sourceIdentity:'own-price',observedAt:at,collectedAt}}] }] }));
  await writeFile(join(root,'prompts.json'),JSON.stringify(promptExport()));
},60000);
afterAll(async () => { await db?.drop(); if(root)await rm(root,{recursive:true,force:true}); });
function promptExport() { return {profileId:scope.profileId,metricSemantics:'disjoint_interval_deltas',rows:[{adProduct:'SP',campaignId:'own-c',adGroupId:'own-g',promptText:'Synthetic own prompt',observedAt:at,status:'live',intervalStart:'2026-06-01T01:00:00.000Z',intervalEnd:at,spend:1,clicks:1,sales:2,orders:1}]}; }
for (const type of types) it(`${type} replays through the real coverage producer without changing identities or coverage`, async () => {
  const registry = new IngestionRegistry((observation,verified) => upsertReportCoverage(db,observation,verified));
  registerOwnCollectors(registry,{...postgresOwnCollectors(db,root,true),now:()=>new Date(collectedAt)});
  const payload: JobPayload = {type,orgId:scope.orgId,profileId:scope.profileId};
  const job: ClaimedJob = {id:scope.orgId,orgId:scope.orgId,profileId:scope.profileId,jobType:type,payload,attempts:1,maxAttempts:3,dedupeKey:null,claim:null,claimedBy:'synthetic'};
  const context = {job,payload,profile:await new PostgresWorkerStore(db).profile(scope.profileId)};
  const first = CollectorReceipt.parse((await registry.dispatch(context)).receipt);
  const before = await db.sql`select * from public.report_coverage where profile_id=${scope.profileId} and source=${type}`;
  const replay = CollectorReceipt.parse((await registry.dispatch(context)).receipt);
  expect(first.counts).toEqual({sourceRows:1,parsedRows:1,refusedRows:0,loadedRows:1,verifiedLoadedRows:1});
  expect(replay.counts).toEqual(first.counts);
  expect(replay.outputIdentities).toEqual(first.outputIdentities);
  expect(replay.observedAt).toBe(at);
  if (type !== 'own_bids.collect') {
    expect(first.sourceImports).toHaveLength(1);
    expect(first.sourceImports![0]!.receipt).toMatchObject({inserted:1,alreadyPresent:0});
    expect(replay.sourceImports).toHaveLength(1);
    expect(replay.sourceImports![0]!.receipt).toMatchObject({inserted:0,alreadyPresent:1});
  }
  expect(before).toHaveLength(1);
  expect(await db.sql`select * from public.report_coverage where profile_id=${scope.profileId} and source=${type}`).toEqual(before);
});
it.each(['malformed_content','scope_mismatch','unauthorized_reference','invalid_file_bounds'] as const)('records %s through the production import and queue failure path', async (code) => {
  const input = promptExport();
  if (code === 'scope_mismatch') input.profileId = '00000000-0000-4000-8000-000000000096';
  const content = code === 'malformed_content' ? '{invalid' : code === 'invalid_file_bounds' ? 'x'.repeat(2*1024*1024+1) : JSON.stringify(input);
  await writeFile(join(root,'prompts.json'),content);
  if(code === 'unauthorized_reference') await db.sql`update public.collector_export_references set object_key='../outside' where profile_id=${scope.profileId} and family='prompts'`;
  const store = new PostgresWorkerStore(db);
  const payload = {type:'prompts.collect' as const,orgId:scope.orgId,profileId:scope.profileId};
  await store.enqueue(payload,new Date(0),`synthetic-refusal-${code}`);
  const worker = new SyncWorker({workerId:'synthetic-own-refusal',store,jobTypes:['prompts.collect'],logger:{info:()=>{},error:()=>{}},
    sources:(registry)=>registerOwnCollectors(registry,postgresOwnCollectors(db,root,true))});
  expect(await worker.drainOnce(1)).toBe(1);
  const [job] = await db.sql<{status:string;last_error:string}[]>`select status,last_error from public.sync_jobs where profile_id=${scope.profileId} and dedupe_key=${`synthetic-refusal-${code}`}`;
  expect(job?.status).toBe('dead');
  expect(CollectorRefusal.parse(JSON.parse(job!.last_error)).code).toBe(code);
  await db.sql`update public.collector_export_references set object_key='prompts.json' where profile_id=${scope.profileId} and family='prompts'`;
});
