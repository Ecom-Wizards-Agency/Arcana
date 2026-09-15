import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { StreamExtensionEvent, type JobPayload, type ProviderGraphScope } from '@wizard-ads/shared';
import { readProviderGraphEvidence, retainStreamExtensionDelivery, upsertReportCoverage, type ClaimedJob } from '@wizard-ads/db';
import { createTestDatabase, type TestDatabase } from '@wizard-ads/db/testing';
import { registerStreamExtensionProjection } from './marketing-stream-extensions.js';
import { IngestionRegistry, type IngestionContext } from './ingestion-registry.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
describe('Stream dimension events through registered graph projection and WP-256 coverage', () => {
  let db: TestDatabase; let scope: ProviderGraphScope;
  const at = new Date(Date.now()-1000).toISOString();
  const fixtures = [
    { datasetId: 'ads-campaign-management-adgroups', observation: { entityId:'group',campaignId:'campaign' } },
    { datasetId: 'ads-campaign-management-ads', observation: { entityId:'ad',campaignId:'campaign',adGroupId:'group' } },
    { datasetId: 'ads-campaign-management-targets', observation: { entityId:'target',campaignId:'campaign',adGroupId:'group' } },
    { datasetId: 'ads-campaign-management-campaigns', observation: { entityId:'campaign' } },
  ] as const;
  const context = (index: number): IngestionContext => {
    const payload: Extract<JobPayload,{type:'marketing_stream.extensions.project'}> = {
      type:'marketing_stream.extensions.project', orgId:scope.orgId,profileId:scope.profileId,
      datasetId:fixtures[index]!.datasetId,eventIdentity:hash(`fixture-${index}`),
    };
    const job: ClaimedJob = { id:randomUUID(),orgId:scope.orgId,profileId:scope.profileId,
      jobType:payload.type,payload,attempts:1,maxAttempts:3,dedupeKey:null,claim:null,claimedBy:'synthetic' };
    return {job,payload,profile:{id:scope.profileId,orgId:scope.orgId,amazonProfileId:scope.amazonProfileId,region:'EU',currencyCode:'EUR',timezone:'UTC'}};
  };
  beforeAll(async () => {
    db=await createTestDatabase('wp313_graph_stream');
    const orgId=randomUUID(); const profileId=randomUUID();
    await db.sql`insert into public.orgs(id,slug,name) values(${orgId},${'graph-stream-'+randomUUID()},'Synthetic graph stream')`;
    await db.sql`insert into public.ad_profiles(id,org_id,amazon_profile_id,region,country_code,currency_code,timezone)
      values(${profileId},${orgId},'synthetic-profile','EU','DE','EUR','UTC')`;
    scope={orgId,profileId,amazonProfileId:'synthetic-profile',region:'EU'};
    for (let i=0;i<fixtures.length;i++) {
      const record = {contractVersion:'fixture.v1',subscriptionId:'subscription',advertiserId:'advertiser',marketplaceId:'market',region:'EU',
        destinationArn:'arn:aws:sqs:eu-west-1:000000000000:synthetic',eventId:`event-${i}`,revision:1,eventTime:at,window:null,
        datasetId:fixtures[i]!.datasetId,observation:{...fixtures[i]!.observation,adProduct:'SD',operation:'patch',state:'enabled'}};
      const event=StreamExtensionEvent.parse({orgId,profileId,identity:hash(`fixture-${i}`),payloadFingerprint:hash(JSON.stringify(record)),receivedAt:at,record});
      await retainStreamExtensionDelivery(db,{deliveryId:hash(`delivery-${i}`),bodyFingerprint:event.payloadFingerprint,
        receivedAt:at,decoded:1,event,reason:null});
    }
  },120000);
  afterAll(async () => {if(db) await db.drop();});
  it('keeps missing parents unresolved, then verifies all five edges after four source events', async () => {
    const coverage=vi.fn((observation,verifiedRows) => upsertReportCoverage(db,observation,verifiedRows));
    const registry=new IngestionRegistry(coverage); registerStreamExtensionProjection(registry,db,()=>true);
    const first=await registry.dispatch(context(0));
    expect(first).toMatchObject({graphReceipt:{observations:{stored:1,verified:1},associations:{stored:1,verified:1}},loadedRows:1});
    expect(await db.sql`select identity from public.provider_entity_associations where org_id=${scope.orgId} and resolution='resolved'`).toHaveLength(0);
    for(let i=1;i<fixtures.length;i++) await registry.dispatch(context(i));
    const evidence=await readProviderGraphEvidence(db,scope,new Date().toISOString());
    expect(evidence.persistedObservations).toBe(4); expect(evidence.persistedAssociations).toBe(5);
    expect(await db.sql`select identity from public.provider_entity_associations where org_id=${scope.orgId} and resolution='resolved'`).toHaveLength(5);
    expect(coverage).toHaveBeenCalledTimes(4);
    for(const [observation,verified] of coverage.mock.calls) {
      expect(observation).toMatchObject({sourceRows:1,parsedRows:1,loadedRows:1,refusedRows:0,status:'partial',observedAt:at});
      expect(verified).toBe(1);
    }
    expect(await db.sql`select id from public.report_coverage where org_id=${scope.orgId} and source='amazon_marketing_stream'`).toHaveLength(4);
    const replay=await registry.dispatch(context(0));
    expect(replay).toMatchObject({graphReceipt:{observations:{stored:0,existing:1,verified:1}}});
    expect((await readProviderGraphEvidence(db,scope,new Date().toISOString())).persistedObservations).toBe(4);
  });
  it('default-off registration refuses before projection or coverage',async () => {
    const coverage=vi.fn(); const registry=new IngestionRegistry(coverage);
    registerStreamExtensionProjection(registry,db);
    await expect(registry.dispatch(context(0))).rejects.toThrow('disabled');
    expect(coverage).not.toHaveBeenCalled();
  });
});
