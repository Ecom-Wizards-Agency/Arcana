import { deriveStreamConsumerEvidence, reconcileProviderGraph } from '@wizard-ads/core';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { StreamExtensionBinding, StreamExtensionRecord, StreamExtensionDataset, ProviderGraphReadResult, type JobPayload } from '@wizard-ads/shared';
import { createTestDatabase, type TestDatabase } from '@wizard-ads/db/testing';
import { appendProviderGraphEvidence, readProviderGraphEvidence, recordProviderGraphResolution, readStreamConsumerSource, readStreamBudgetHandoff, upsertReportCoverage, reconcileStreamExtensionWork } from '@wizard-ads/db';
import fixtures from './fixtures/stream-extension-deliveries.json';
import { assertStreamQueueDestination, parseRegisteredStreamDataset, streamDatasetAdapters, streamExtensionPolicyFromEnv } from './stream-dataset-adapters.js';
import { createStreamExtensionIntake, registerStreamExtensionProjection } from './marketing-stream-extensions.js';
import { IngestionRegistry } from './ingestion-registry.js';
import { MarketingStreamSqsConsumer } from './marketing-stream-sqs.js';
import type { MarketingStreamStore } from './dayparting.js';

async function readStreamConsumerEvidence(handle: Parameters<typeof readStreamConsumerSource>[0], input: Parameters<typeof readStreamConsumerSource>[1]) { return deriveStreamConsumerEvidence(await readStreamConsumerSource(handle,input),input); }
let db: TestDatabase;
const orgId = randomUUID(), profileId = randomUUID();
const destinationArn = fixtures.records[0]!.destinationArn;
beforeAll(async () => {
  db = await createTestDatabase('wp313_registered');
  await db.sql`insert into public.orgs(id,slug,name) values(${orgId},${'registered-'+orgId},'Synthetic registered streams')`;
  await db.sql`insert into public.ad_profiles(id,org_id,amazon_profile_id,region,country_code,currency_code,timezone)
    values(${profileId},${orgId},'313','EU','DE','EUR','UTC')`;
  for (const raw of fixtures.records) {
    const record = StreamExtensionRecord.parse(raw);
    const binding = StreamExtensionBinding.parse({ orgId,profileId,datasetId:record.datasetId,subscriptionId:record.subscriptionId,
      advertiserId:record.advertiserId,marketplaceId:record.marketplaceId,region:record.region,destinationArn,
      contractVersion:record.contractVersion,enabled:true,confirmed:true,capabilityVerified:true });
    await db.sql`insert into public.marketing_stream_extension_bindings(org_id,profile_id,dataset_id,subscription_id,destination_arn,binding,enabled,confirmed,capability_verified)
      values(${orgId},${profileId},${record.datasetId},${record.subscriptionId},${destinationArn},${JSON.stringify(binding)}::jsonb,true,true,true)`;
  }
},120000);
afterAll(async () => { await db?.drop(); });
it('registers exactly eight strict parsers and defaults all infrastructure admission off', () => {
  expect(streamDatasetAdapters.map((a) => a.datasetId)).toEqual(StreamExtensionDataset.options);
  expect(streamDatasetAdapters.every((a) => a.enabledByDefault === false)).toBe(true);
  expect(streamExtensionPolicyFromEnv({})).toEqual({ enabled:false,destinationArn:null });
  expect(()=>assertStreamQueueDestination('https://sqs.eu-west-1.amazonaws.com/000000000000/synthetic',destinationArn)).not.toThrow();
  expect(()=>assertStreamQueueDestination('https://sqs.eu-west-1.amazonaws.com/000000000000/other',destinationArn)).toThrow('mismatch');
  expect(fixtures.records.map(parseRegisteredStreamDataset)).toHaveLength(fixtures.expected.parsed);
  expect(() => parseRegisteredStreamDataset({ ...fixtures.records[0],datasetId:'dsp-traffic' })).toThrow();
  expect(() => parseRegisteredStreamDataset({ ...fixtures.records[6],observation:{ ...fixtures.records[6]!.observation,personId:'refused' } })).toThrow();
});
it('accounts fake SQS → eight adapters → durable jobs → readers and WP-256; replay loads once', async () => {
  const intake = createStreamExtensionIntake(db,destinationArn,true);
  let delivery = 0;
  const deleted = vi.fn();
  const consumer = new MarketingStreamSqsConsumer({ queueUrl:'https://sqs.example.invalid/fixture',
    queue:{receive:async () => fixtures.records.map((record,index) => ({messageId:`${delivery}-${index}`,receiptHandle:`receipt-${index}`,
      body:JSON.stringify({Type:'Notification',Message:JSON.stringify(record)}),approximateReceiveCount:1})),delete:deleted,destroy:vi.fn()},
    store:{} as MarketingStreamStore,contexts:{load:vi.fn()},logger:{info:vi.fn(),error:vi.fn()},
    extensionIntake:async (message) => intake.retain({messageId:message.messageId!,body:message.body!}),
  });
  expect(await consumer.pollOnce()).toBe(8); expect(deleted).toHaveBeenCalledTimes(8);
  const jobs = await db.sql<{id:string;payload:JobPayload}[]>`select id,payload from public.sync_jobs where org_id=${orgId} order by payload->>'datasetId'`;
  expect(jobs).toHaveLength(8);
  await db.sql`update public.sync_jobs set status='running',claimed_by='fixture',attempts=1 where org_id=${orgId}`;
  const coverage = vi.fn((observation,verified) => upsertReportCoverage(db,observation,verified));
  const registry = new IngestionRegistry(coverage);registerStreamExtensionProjection(registry,db,()=>true);
  for (const job of jobs) {
    const result = await registry.dispatch({job:{id:job.id,orgId,profileId,jobType:job.payload.type,payload:job.payload,attempts:1,maxAttempts:8,dedupeKey:null,claimedBy:'fixture',claim:null},
      payload:job.payload,profile:{id:profileId,orgId,amazonProfileId:'313',region:'EU',currencyCode:'EUR',timezone:'UTC'}});
    expect(result).toMatchObject({sourceRows:1,parsedRows:1,refusedRows:0,loadedRows:1,verifiedLoadedRows:1});
  }
  expect(coverage).toHaveBeenCalledTimes(8);
  for (const [observation,verified] of coverage.mock.calls) {
    expect(observation.sourceRows).toBe(observation.parsedRows+observation.refusedRows);
    expect(observation.loadedRows).toBe(verified);expect(observation.observedAt).toBe('2026-09-15T12:00:00.000Z');
  }
  expect(await db.sql`select id from public.report_coverage where org_id=${orgId}`).toHaveLength(8);
  const asOf = new Date(Math.max(Date.now(),Date.parse('2026-09-15T13:00:00Z'))).toISOString();
  const evidence = await readStreamConsumerEvidence(db,{orgId,profileId,datasets:StreamExtensionDataset.options,asOf,maxAgeMs:86400000});
  expect(evidence.measured).toBe(6);expect(evidence.unresolved).toBe(2);
  const budgetAdvice=await readStreamBudgetHandoff(db,{orgId,profileId,
    datasetId:'sp-budget-recommendations',asOf,maxAgeMs:86400000});
  expect(budgetAdvice).toMatchObject([{transport:'marketing_stream',observedUsage:null,approvalAuthority:false}]);
  delivery++;await consumer.pollOnce();await consumer.pollOnce();
  expect(deleted).toHaveBeenCalledTimes(24);
  expect(await db.sql`select identity from public.marketing_stream_extension_events where org_id=${orgId}`).toHaveLength(8);
  expect(await db.sql`select delivery_id from public.marketing_stream_extension_receipts`).toHaveLength(16);
  expect(await db.sql`select id from public.recommendation_preview_batches where org_id=${orgId}`).toHaveLength(0);
});
it('measures stored zero clicks and seven engagements only after exact endpoint resolution; excludes wrong assets and partial windows', async () => {
  const scope = {orgId,profileId,amazonProfileId:'313',region:'EU' as const};
  const sourceEventAt='2026-09-15T10:00:00.000Z';
  const now = new Date(Math.max(Date.now(),Date.parse('2026-09-15T13:00:00Z'))).toISOString();
  const creative = {adProduct:'SB',kind:'creative',providerId:'creative',version:'1'};
  const asset = {adProduct:'SB',kind:'asset',providerId:'asset',version:'1'};
  const campaign = {adProduct:'SB',kind:'campaign',providerId:'campaign',version:null};
  const common = {scope,sourceEventAt,observedAt:sourceEventAt,revision:'1',payloadFingerprint:'d'.repeat(64),operation:'upsert'};
  await appendProviderGraphEvidence(db,scope,ProviderGraphReadResult.parse({sourceRows:3,parsed:3,refusals:[],pages:1,completeness:'partial',
    observations:[creative,asset,campaign].map(identity=>({...common,identity,source:'product_api',contractVersion:'fixture.v1',state:'enabled'})),
    associations:[{...common,from:creative,to:asset,relation:'asset'},{...common,from:creative,to:campaign,relation:'parent'}].map(({observedAt:_,...edge})=>edge)}));
  const stored = await readProviderGraphEvidence(db,scope,now);
  const graph = reconcileProviderGraph({scope,observations:stored.observations,associations:stored.associations});
  await recordProviderGraphResolution(db,scope,graph.resolved,stored,now);
  const input = {orgId,profileId,datasets:['sb-clickstream','sb-rich-media'] as const,asOf:now,maxAgeMs:86400000,assetId:'asset'};
  const measured=await readStreamConsumerEvidence(db,input);
  expect(measured).toMatchObject({measured:2,unresolved:0});
  expect(measured.events.map(e=>e.record.observation)).toEqual(expect.arrayContaining([expect.objectContaining({clicks:0}),expect.objectContaining({engagements:7})]));
  expect((await readStreamConsumerEvidence(db,{...input,assetId:'other'})).measured).toBe(0);
  expect(await readStreamConsumerEvidence(db,{...input,from:'2026-09-15T11:30:00.000Z'})).toMatchObject({measured:0,unresolved:2});
  const stale=await readStreamConsumerEvidence(db,{...input,asOf:new Date(Date.parse(now)+2*86400000).toISOString()});
  expect(stale.completeness).toBe('stale');
});
it('rechecks binding revocation, defers durable backoff, fences custody and replays success without consuming attempts', async () => {
  const [queued]=await db.sql<{id:string;payload:Extract<JobPayload,{type:'marketing_stream.extensions.project'}>}[]>`select id,payload from public.sync_jobs
    where org_id=${orgId} and payload->>'datasetId'='ads-campaign-management-campaigns'`;
  const payload=queued!.payload;
  const context={job:{id:queued!.id,orgId,profileId,jobType:payload.type,payload,attempts:1,maxAttempts:8,dedupeKey:null,claimedBy:'fixture',claim:null},
    payload,profile:{id:profileId,orgId,amazonProfileId:'313',region:'EU' as const,currencyCode:'EUR',timezone:'UTC'}};
  const coverage=vi.fn((observation,verified)=>upsertReportCoverage(db,observation,verified));
  const registry=new IngestionRegistry(coverage);registerStreamExtensionProjection(registry,db,()=>true);
  const [before]=await db.sql<{attempts:number}[]>`select attempts from public.marketing_stream_extension_projections where identity=${payload.eventIdentity}`;
  for(let i=0;i<10;i++) await registry.dispatch(context);
  expect((await db.sql`select attempts from public.marketing_stream_extension_projections where identity=${payload.eventIdentity}`)[0]?.attempts).toBe(before!.attempts);
  await expect(registry.dispatch({...context,job:{...context.job,claimedBy:'wrong-worker'}})).rejects.toThrow('custody');
  await db.sql`update public.marketing_stream_extension_bindings set enabled=false where org_id=${orgId} and dataset_id=${payload.datasetId}`;
  coverage.mockClear();await expect(registry.dispatch(context)).rejects.toThrow('refused');expect(coverage).not.toHaveBeenCalled();
  await db.sql`update public.marketing_stream_extension_bindings set enabled=true where org_id=${orgId} and dataset_id=${payload.datasetId}`;
  await db.sql`update public.marketing_stream_extension_projections set status='retrying',retry_after=now()+interval '1 hour' where identity=${payload.eventIdentity}`;
  await expect(registry.dispatch(context)).rejects.toThrow('not due');
  expect((await db.sql`select attempts from public.marketing_stream_extension_projections where identity=${payload.eventIdentity}`)[0]?.attempts).toBe(before!.attempts);
  await db.sql`update public.marketing_stream_extension_projections set retry_after=null where identity=${payload.eventIdentity}`;
  await registry.dispatch(context);
});
it('repairs missing queue work at startup once and refuses disabled bindings', async () => {
  await db.sql`update public.sync_jobs set status='dead' where org_id=${orgId}`;
  expect(await reconcileStreamExtensionWork(db)).toMatchObject({requested:0,attempted:0});
  expect(await reconcileStreamExtensionWork(db,true)).toMatchObject({requested:8,attempted:8,succeeded:8,failed:0,refused:0});
  expect(await reconcileStreamExtensionWork(db,true)).toMatchObject({requested:0});
  expect(await db.sql`select id from public.sync_jobs where org_id=${orgId} and status='queued'`).toHaveLength(8);
});

it('bounds coverage recovery after projection succeeded, without repeating durable loads', async () => {
  await db.sql`update public.sync_jobs set status='dead',attempts=1 where org_id=${orgId}`;
  expect(await reconcileStreamExtensionWork(db,true)).toMatchObject({requested:8,succeeded:8,refused:0});
  await db.sql`update public.sync_jobs set status='dead',attempts=8 where org_id=${orgId} and status='queued'`;
  expect(await reconcileStreamExtensionWork(db,true)).toMatchObject({requested:8,attempted:0,succeeded:0,refused:8});
  expect(await db.sql`select identity from public.marketing_stream_extension_events where org_id=${orgId}`).toHaveLength(8);
  expect(await db.sql`select id from public.report_coverage where org_id=${orgId}`).toHaveLength(8);
  expect(await db.sql`select id from public.sync_jobs where org_id=${orgId} and status='queued'`).toHaveLength(0);
});
