import { describe, expect, it, vi } from 'vitest';
import type { ChangeHistoryPage, ProductEligibilityResult, ValidationResult } from '@wizard-ads/ads-api';
import { readProductEvidence, readAmazonObservedChanges, type PersistCatalogueCollectionInput, type QueryHandle } from '@wizard-ads/db';
import { createTestDatabase } from '@wizard-ads/db/testing';
import type { JobPayload } from '@wizard-ads/shared';
import type { CatalogueAdsClient, AdsProfileContext } from './ads-api.js';
import { CatalogueSourceRunner, registerCatalogueSources } from './catalogue-sources.js';
import { IngestionRegistry, type IngestionContext } from './ingestion-registry.js';

const orgId = '11111111-1111-4111-8111-111111111111';
const profileId = '22222222-2222-4222-8222-222222222222';
const marketplaceId = 'A1SYNTHETIC';
const profile: AdsProfileContext = { id: profileId, orgId, amazonProfileId: 'synthetic-profile', region: 'EU', currencyCode: 'EUR', timezone: 'UTC' };
const handle = {} as QueryHandle;
type CatalogueJob=Extract<JobPayload,{type:'ads.product_metadata.sync'|'ads.product_eligibility.sync'|'ads.validation_configurations.sync'|'ads.change_history.sync'}>;

function context<T extends JobPayload>(payload: T): IngestionContext<T['type']> {
  return { payload, profile, job: { id: '33333333-3333-4333-8333-333333333333', orgId, profileId, jobType: payload.type, payload, attempts: 1, maxAttempts: 3, dedupeKey: null, claim: null, claimedBy: 'synthetic' } } as IngestionContext<T['type']>;
}

function fakeClient(overrides: Partial<CatalogueAdsClient> = {}): CatalogueAdsClient {
  return {
    getProductMetadataPage: vi.fn(async () => ({ sourceRows: 1, nextToken: null, rows: [{ asin: 'B000TEST01', sku: null, title: 'Synthetic product', imageUrl: 'https://images.example.test/item.jpg', category: null, variationList: [], priceToPay: { amount: 0, currency: 'EUR' }, basisPrice: null, availability: null, bestSellerRank: 0 }] })),
    getProductEligibility: vi.fn(async ():Promise<ProductEligibilityResult> => ({ sourceRows: 1, missingAsins: [], rows: [{ asin: 'B000TEST01', sku: null, overallStatus: 'INELIGIBLE', reasons: [{ code: 'SYNTHETIC_REASON', message: 'Synthetic reason', severity: null }] }] })),
    getValidationConfigurations: vi.fn(async (_profile, resource):Promise<ValidationResult> => ({ sourceRows: 1, rows: [{ countryCode: 'DE', adType: 'SP', entityType: 'SELLER', configuration: { resource, syntheticRule: true } }] })),
    getChangeHistoryPage: vi.fn(async ():Promise<ChangeHistoryPage> => ({ sourceRows: 1, nextToken: null, rows: [{ entityType: 'CAMPAIGN', entityId: '987654321', changeType: 'BUDGET', timestamp: Date.parse('2026-09-14T10:00:00.000Z'), previousValue: '1', newValue: '2', metadata: { source: 'synthetic' } }] })),
    ...overrides,
  };
}

function harness(
  client: CatalogueAdsClient,
  enabled: (scope: { profileId: string }) => Promise<boolean> = async () => true,
) {
  const persisted: PersistCatalogueCollectionInput[] = [];
  const persist = vi.fn(async (_handle: QueryHandle, input: PersistCatalogueCollectionInput) => {
    persisted.push(input);
    return { receiptId: '44444444-4444-4444-8444-444444444444', counts: { requestedMembers: input.parsedRows + input.refusedRows, pages: input.pages, sourceRows: input.sourceRows, parsedRows: input.parsedRows, refusedRows: input.refusedRows, duplicates: input.duplicates, canonicalRows: input.rows.length, writtenRows: input.rows.length, existingRows: 0, verifiedRows: input.rows.length } };
  });
  const recordFailure = vi.fn(async () => {});
  let tick = 0;
  const runner = new CatalogueSourceRunner({ handle, client, deploymentEnabled: () => true, isEnabled: enabled, persist, recordFailure, now: () => new Date(Date.parse('2026-09-15T00:00:00.000Z') + tick++ * 1_000) });
  return { runner, persist, persisted, recordFailure };
}

describe('catalogue source registration and execution', () => {
  it('registers the four integrations-lane families with verified coverage', () => {
    const registered: string[] = [];
    const registry = new IngestionRegistry(vi.fn(async () => ({ offered: 1, written: 1, unchanged: 0 })));
    const original = registry.register.bind(registry);
    registry.register = ((handlers: Parameters<typeof original>[0]) => { registered.push(handlers.source.jobType); original(handlers); }) as typeof registry.register;
    registerCatalogueSources(registry, harness(fakeClient()).runner);
    expect(registered).toEqual(['ads.product_metadata.sync', 'ads.product_eligibility.sync', 'ads.validation_configurations.sync', 'ads.change_history.sync']);
  });

  it('reconciles metadata and explicit missing members without inventing availability', async () => {
    const client = fakeClient({ getProductMetadataPage: vi.fn(async () => ({ sourceRows: 1, nextToken: null, rows: [{ asin: 'B000TEST01', sku: null, title: null, imageUrl: 'https://images.example.test/item.jpg?X-Amz-Signature=secret', category: null, variationList: null, priceToPay: { amount: 0, currency: 'EUR' }, basisPrice: null, availability: null, bestSellerRank: 0 }] })) });
    const h = harness(client);
    const plan = await h.runner.plan(context({ type: 'ads.product_metadata.sync', orgId, profileId, marketplaceId, sourceEnabled: true, asins: ['B000TEST01', 'B000TEST02'], adProduct: 'SP' }));
    const result = await h.runner.execute(plan);
    expect(result).toMatchObject({ sourceRows: 2, parsedRows: 1, refusedRows: 1, loadedRows: 2, verifiedLoadedRows: 2, pages: 1 });
    const rows = h.persisted[0]!.rows;
    expect(rows[0]).toMatchObject({ asin: 'B000TEST01', price: { state: 'returned', value: { amount: 0 } }, bestSellerRank: { state: 'returned', value: 0 }, availability: { state: 'absent' }, imageUrl: { state: 'absent' } });
    expect(rows[1]).toMatchObject({ asin: 'B000TEST02', availability: { state: 'refused' } });
  });

  it('keeps eligibility verdicts, validation rules and Amazon-observed history distinct', async () => {
    const h = harness(fakeClient());
    const jobs: CatalogueJob[] = [
      { type: 'ads.product_eligibility.sync', orgId, profileId, marketplaceId, sourceEnabled: true, asins: ['B000TEST01'], adProduct: 'SP' },
      { type: 'ads.validation_configurations.sync', orgId, profileId, marketplaceId, sourceEnabled: true, countryCode: 'DE', entityType: 'SELLER', adProducts: ['SP'] },
      { type: 'ads.change_history.sync', orgId, profileId, marketplaceId, sourceEnabled: true, from: '2026-09-14T00:00:00.000Z', to: '2026-09-15T00:00:00.000Z' },
    ];
    for (const job of jobs) await h.runner.execute(await h.runner.plan(context(job)));
    expect(h.persisted[0]!.rows[0]).toMatchObject({ verdict: 'ineligible', reasons: [{ code: 'SYNTHETIC_REASON' }] });
    expect(h.persisted[1]!.rows).toHaveLength(2);
    expect(h.persisted[1]!.rows[0]).toMatchObject({ providerVersion: null, configuration: { syntheticRule: true } });
    expect(h.persisted[2]!.rows[0]).toMatchObject({ sourceNamespace: 'amazon_ads_change_history_v1', identityQuality: 'derived', occurredAt: '2026-09-14T10:00:00.000Z' });
  });

  it('bounds event metadata and keeps conflicting payloads under one derived identity', async () => {
    const oversizedMetadata = Object.fromEntries([
      ['valid-key', 'x'.repeat(300)],
      ['invalid key', 'discarded'],
      ...Array.from({ length: 21 }, (_, index) => [`key${index}`, `value${index}`]),
    ]);
    const client = fakeClient({
      getChangeHistoryPage: vi.fn(async (): Promise<ChangeHistoryPage> => ({
        sourceRows: 2,
        nextToken: null,
        rows: [
          { entityType: 'CAMPAIGN', entityId: '987654321', changeType: 'BUDGET', timestamp: Date.parse('2026-09-14T10:00:00.000Z'), previousValue: '1', newValue: '2', metadata: oversizedMetadata },
          { entityType: 'CAMPAIGN', entityId: '987654321', changeType: 'BUDGET', timestamp: Date.parse('2026-09-14T10:00:00.000Z'), previousValue: '1', newValue: '3', metadata: { source: 'different' } },
        ],
      })),
    });
    const h = harness(client);
    await h.runner.execute(await h.runner.plan(context({ type: 'ads.change_history.sync', orgId, profileId, marketplaceId, sourceEnabled: true, from: '2026-09-14T00:00:00.000Z', to: '2026-09-15T00:00:00.000Z' })));
    const [first, second] = h.persisted[0]!.rows as unknown as readonly { sourceEventKey: string; metadata: Record<string, string> }[];
    expect(first!.sourceEventKey).toBe(second!.sourceEventKey);
    expect(Object.keys(first!.metadata)).toHaveLength(20);
    expect(first!.metadata['valid-key']).toHaveLength(256);
    expect(first!.metadata['invalid key']).toBeUndefined();
  });

  it('makes disabled admission produce zero provider calls and zero persistence', async () => {
    const client = fakeClient();
    const h = harness(client, async () => false);
    await expect(h.runner.plan(context({ type: 'ads.product_metadata.sync', orgId, profileId, marketplaceId, sourceEnabled: true, asins: ['B000TEST01'], adProduct: 'SP' }))).rejects.toThrow('source is disabled');
    expect(client.getProductMetadataPage).not.toHaveBeenCalled();
    expect(h.persist).not.toHaveBeenCalled();
  });

  it('fails closed for missing client configuration and a mismatched profile scope', async()=>{
    const withoutClient=new CatalogueSourceRunner({handle,client:undefined,deploymentEnabled:()=>true,isEnabled:async()=>true,persist:vi.fn()});
    const payload={type:'ads.product_metadata.sync' as const,orgId,profileId,marketplaceId,sourceEnabled:true as const,asins:['B000TEST01'],adProduct:'SP' as const};
    await expect(withoutClient.plan(context(payload))).rejects.toThrow('not configured');
    const client=fakeClient();const wrong=harness(client,async(scope)=>scope.profileId==='different-profile');
    await expect(wrong.runner.plan(context(payload))).rejects.toThrow('source is disabled');
    expect(client.getProductMetadataPage).not.toHaveBeenCalled();expect(wrong.persist).not.toHaveBeenCalled();
  });

  it('rejects profile mismatches and unrequested metadata before persistence',async()=>{
    const client=fakeClient(),h=harness(client);
    const payload={type:'ads.product_metadata.sync' as const,orgId,profileId,marketplaceId,sourceEnabled:true as const,asins:['B000OTHER1'],adProduct:'SP' as const};
    const wrong=context(payload);wrong.profile={...profile,id:'44444444-4444-4444-8444-444444444444'};
    await expect(h.runner.plan(wrong)).rejects.toThrow('profile scope mismatch');
    expect(client.getProductMetadataPage).not.toHaveBeenCalled();
    await expect(h.runner.execute(await h.runner.plan(context(payload)))).rejects.toThrow('unrequested ASIN');
    expect(h.persist).not.toHaveBeenCalled();
  });

  it('refuses windows outside the retained past before calling the provider',async()=>{
    const client=fakeClient(),h=harness(client);
    const payload={type:'ads.change_history.sync' as const,orgId,profileId,marketplaceId,sourceEnabled:true as const,from:'2026-01-01T00:00:00.000Z',to:'2026-01-02T00:00:00.000Z'};
    await expect(h.runner.plan(context(payload))).rejects.toThrow('provider retention');
    expect(client.getChangeHistoryPage).not.toHaveBeenCalled();
    expect(h.persist).not.toHaveBeenCalled();
  });

  it('counts a repeated history event across pages once despite later retrieval time',async()=>{
    const event={entityType:'CAMPAIGN',entityId:'987654321',changeType:'BUDGET',timestamp:Date.parse('2026-09-14T10:00:00.000Z'),previousValue:'1',newValue:'2',metadata:{}};
    const page=vi.fn().mockResolvedValueOnce({sourceRows:1,rows:[event],nextToken:'second'}).mockResolvedValueOnce({sourceRows:1,rows:[event],nextToken:null});
    const h=harness(fakeClient({getChangeHistoryPage:page}));
    const result=await h.runner.execute(await h.runner.plan(context({type:'ads.change_history.sync',orgId,profileId,marketplaceId,sourceEnabled:true,from:'2026-09-14T00:00:00.000Z',to:'2026-09-15T00:00:00.000Z'})));
    expect(result).toMatchObject({pages:2,sourceRows:2,parsedRows:2,duplicates:1,loadedRows:1,verifiedLoadedRows:1});
    expect(h.persisted[0]!.rows).toHaveLength(1);
  });

  it('stops after revocation between history pages and records no receipt or cursor advance', async () => {
    const page = vi.fn().mockResolvedValueOnce({ sourceRows: 1, rows: [{ entityType: 'CAMPAIGN', entityId: '987654321', changeType: 'NAME', timestamp: Date.parse('2026-09-14T10:00:00.000Z'), previousValue: 'old', newValue: 'new', metadata: {} }], nextToken: 'next' });
    let checks = 0;
    const h = harness(fakeClient({ getChangeHistoryPage: page }), async () => ++checks < 3);
    const plan = await h.runner.plan(context({ type: 'ads.change_history.sync', orgId, profileId, marketplaceId, sourceEnabled: true, from: '2026-09-14T00:00:00.000Z', to: '2026-09-15T00:00:00.000Z' }));
    await expect(h.runner.execute(plan)).rejects.toThrow('source is disabled');
    expect(page).toHaveBeenCalledTimes(1);
    expect(h.persist).not.toHaveBeenCalled();
    expect(h.recordFailure).toHaveBeenCalledTimes(1);
  });
});

// One bounded synthetic collection per family, through the real destination transaction.
it('persists all four fake-provider families and independently reads their scoped evidence', async () => {
  const database = await createTestDatabase('catalogue_pipeline');
  try {
    const [tenant] = await database.sql<{id:string}[]>`select app.seed_tenant_fixture('catalogue-pipeline',${orgId}::uuid) as id`;
    const [storedProfile] = await database.sql<{id:string}[]>`select id from public.ad_profiles where org_id=${tenant!.id} limit 1`;
    const scope = { orgId:tenant!.id, profileId:storedProfile!.id, marketplaceId };
    const runner = new CatalogueSourceRunner({ handle:database,client:fakeClient(),deploymentEnabled:()=>true,isEnabled:async()=>true,now:()=>new Date('2026-09-15T00:00:00.000Z') });
    const common = {...scope,sourceEnabled:true as const};
    const jobs:CatalogueJob[] = [
      {...common,type:'ads.product_metadata.sync',asins:['B000TEST01'],adProduct:'SP'},
      {...common,type:'ads.product_eligibility.sync',asins:['B000TEST01'],adProduct:'SP'},
      {...common,type:'ads.validation_configurations.sync',countryCode:'DE',entityType:'SELLER',adProducts:['SP']},
      {...common,type:'ads.change_history.sync',from:'2026-09-14T00:00:00.000Z',to:'2026-09-15T00:00:00.000Z'},
    ];
    const counts:number[] = [];
    for(const payload of jobs) {
      const input = context(payload);
      input.profile = {...profile,id:scope.profileId,orgId:scope.orgId};
      const result = await runner.execute(await runner.plan(input));
      expect(result.loadedRows).toBe(result.verifiedLoadedRows);
      counts.push(result.verifiedLoadedRows);
    }
    expect(counts).toEqual([1,1,2,1]);
    const evidence = await readProductEvidence(database,{scope,asins:['B000TEST01'],adProduct:'SP',staleAfter:'2026-09-14T00:00:00.000Z'});
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({availability:'measured',metadata:{price:{value:{amount:0}}},eligibility:{verdict:'ineligible'}});
    expect(await readAmazonObservedChanges(database,scope)).toHaveLength(1);
    const [stored] = await database.sql<{count:number}[]>`select count(*)::int as count from public.ads_validation_configurations where org_id=${scope.orgId} and profile_id=${scope.profileId} and marketplace_id=${marketplaceId}`;
    expect(stored!.count).toBe(2);
    const receipts = await database.sql`select family,counts from public.ads_catalogue_source_receipts where org_id=${scope.orgId} and profile_id=${scope.profileId} and marketplace_id=${marketplaceId}`;
    expect(receipts).toHaveLength(4);
    expect(receipts.find(row=>row['family']==='product_metadata')?.['counts']).toMatchObject({requestedMembers:1});
    expect(receipts.find(row=>row['family']==='change_history')?.['counts']).toMatchObject({requestedMembers:0});
  } finally { await database.drop(); }
},120_000);
