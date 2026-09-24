import { describe, expect, it, vi } from 'vitest';
import type { ChangeHistoryPage, ProductEligibilityResult, ValidationResult } from '@wizard-ads/ads-api';
import { catalogueRowIdentity, readProductEvidence, readAmazonObservedChanges, upsertReportCoverage, persistCataloguePage, type resumeCatalogueAcquisition, type PersistCatalogueCollectionInput, type CatalogueAcquisitionState, type QueryHandle } from '@wizard-ads/db';
import { createTestDatabase } from '@wizard-ads/db/testing';
import type { JobPayload } from '@wizard-ads/shared';
import type { CatalogueAdsClient, AdsProfileContext } from './ads-api.js';
import { CatalogueSourceRunner, registerCatalogueSources } from './catalogue-sources.js';
import { PostgresWorkerStore } from './store.js';
import { IngestionRegistry, type IngestionContext } from './ingestion-registry.js';

const orgId = '11111111-1111-4111-8111-111111111111';
const profileId = '22222222-2222-4222-8222-222222222222';
const marketplaceId = 'A1SYNTHETIC';
const profile: AdsProfileContext = { id: profileId, orgId, amazonProfileId: 'synthetic-profile', region: 'EU', currencyCode: 'EUR', timezone: 'UTC' };
const handle = {} as QueryHandle;
type CatalogueJob=Extract<JobPayload,{type:'ads.product_metadata.sync'|'ads.product_eligibility.sync'|'ads.validation_configurations.sync'|'ads.change_history.sync'}>;

function context<T extends CatalogueJob>(payload: T): IngestionContext<T['type']> {
  return { payload, profile, job: { id: `33333333-3333-4333-8333-${String(['ads.product_metadata.sync','ads.product_eligibility.sync','ads.validation_configurations.sync','ads.change_history.sync'].indexOf(payload.type)+1).padStart(12,'0')}`, orgId:payload.orgId, profileId:payload.profileId, jobType: payload.type, payload, attempts: 1, maxAttempts: 3, dedupeKey: null, claim: null, claimedBy: 'synthetic' } } as IngestionContext<T['type']>;
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
  const states=new Map<string,CatalogueAcquisitionState>();
  const resume:typeof resumeCatalogueAcquisition=async(_handle,request)=>{
    const existing=states.get(request.id);if(existing) return existing;
    const state:CatalogueAcquisitionState={request,acquiredAt:request.proposedAcquiredAt,windowStart:request.windowStart??request.proposedAcquiredAt,windowEnd:request.windowEnd??request.proposedAcquiredAt,next:{page:0,unit:0,token:null},pages:[],result:null,attemptWrittenRows:0};states.set(request.id,state);return state;
  };
  const persistPage:typeof persistCataloguePage=async(_handle,input)=>{
    const state=input.acquisition;
    const evidence:PersistCatalogueCollectionInput={scope:state.request.scope,family:state.request.family,selectorKey:state.request.selectorKey,windowStart:state.windowStart,windowEnd:state.windowEnd,acquiredAt:state.acquiredAt,requestedMembers:state.request.requestedMembers,pages:1,finalCursor:null,sourceRows:input.sourceRows,parsedRows:input.parsedRows,refusedRows:input.refusedRows,duplicates:input.duplicates,rows:input.rows};
    state.pages.push({expected:input.expected,next:input.next,evidence});state.next=input.next;state.attemptWrittenRows=input.rows.length;
    if(input.next===null) {
      const rows=new Map<string,typeof input.rows[number]>();let sourceRows=0,parsedRows=0,refusedRows=0,duplicates=0;
      for(const page of state.pages){sourceRows+=page.evidence.sourceRows;parsedRows+=page.evidence.parsedRows;refusedRows+=page.evidence.refusedRows;duplicates+=page.evidence.duplicates;for(const row of page.evidence.rows){const key=catalogueRowIdentity(row);if(rows.has(key))duplicates++;else rows.set(key,row);}}
      state.result=await persist(_handle,{...evidence,sourceRows,parsedRows,refusedRows,duplicates,rows:[...rows.values()],pages:state.pages.length});
    }
    return state;
  };
  const runner = new CatalogueSourceRunner({ handle, client, deploymentEnabled: () => true, isEnabled: enabled, resume, persistPage, recordFailure, now: () => new Date(Date.parse('2026-09-15T00:00:00.000Z') + tick++ * 1_000) });
  return { runner, persist, persisted, recordFailure, states };
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
    const withoutClient=new CatalogueSourceRunner({handle,client:undefined,deploymentEnabled:()=>true,isEnabled:async()=>true,persistPage:vi.fn()});
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
    const h = harness(fakeClient({ getChangeHistoryPage: page }), async () => ++checks < 4);
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
    expect(receipts).toHaveLength(9);
    expect(receipts.filter(row=>row['family']==='validation_configurations')).toHaveLength(3);
    expect(receipts.filter(row=>row['family']==='product_metadata').some(row=>(row['counts'] as {requestedMembers:number}).requestedMembers===1)).toBe(true);
    expect(receipts.find(row=>row['family']==='change_history')?.['counts']).toMatchObject({requestedMembers:0});
  } finally { await database.drop(); }
},120_000);

it('resumes durable pages after provider crashes and republishes coverage after a completion crash',async()=>{
  const database=await createTestDatabase('catalogue_crashes');
  try {
    const [tenant]=await database.sql<{id:string}[]>`select app.seed_tenant_fixture('catalogue-crashes',${orgId}::uuid) as id`;
    const [stored]=await database.sql<{id:string}[]>`select id from public.ad_profiles where org_id=${tenant!.id} limit 1`;
    const scope={orgId:tenant!.id,profileId:stored!.id,marketplaceId};
    const payload={...scope,type:'ads.change_history.sync' as const,sourceEnabled:true as const,from:'2026-09-14T00:00:00.000Z',to:'2026-09-15T00:00:00.000Z'};
    const input=context(payload);input.profile={...profile,...scope,id:scope.profileId};input.job={...input.job,orgId:scope.orgId,profileId:scope.profileId};
    const tokens:Array<string|null>=[];let failPage=true,failCoverage=true;
    const base={entityType:'CAMPAIGN' as const,entityId:'987654321',changeType:'BUDGET',timestamp:Date.parse('2026-09-14T10:00:00.000Z'),previousValue:'1',newValue:'2',metadata:{}};
    const client=fakeClient({getChangeHistoryPage:vi.fn(async(_profile,request)=>{tokens.push(request.nextToken??null);if(request.nextToken&&failPage){failPage=false;throw new Error('synthetic provider crash');}return {sourceRows:1,rows:[{...base,entityId:request.nextToken?'second-event':'first-event'}],nextToken:request.nextToken?null:'second'};})});
    let clock=0;
    const runner=new CatalogueSourceRunner({handle:database,client,deploymentEnabled:()=>true,isEnabled:async()=>true,now:()=>new Date(Date.parse('2026-09-15T00:00:00.000Z')+clock++*1000)});
    const producer=vi.fn(async(...args:Parameters<typeof upsertReportCoverage> extends [unknown,...infer R]?R:never)=>{if(failCoverage){failCoverage=false;throw new Error('synthetic coverage crash');}return upsertReportCoverage(database,...args);});
    const registry=new IngestionRegistry(producer);registerCatalogueSources(registry,runner);
    await expect(registry.dispatch({...input})).rejects.toThrow('provider crash');expect(tokens).toEqual([null,'second']);expect(producer).not.toHaveBeenCalled();
    const [progress]=await database.sql<{next_position:unknown;acquired_at:Date}[]>`select next_position,acquired_at from public.ads_catalogue_acquisitions where org_id=${scope.orgId} and id=${input.job.id}`;
    expect(progress!.next_position).toEqual({page:1,unit:0,token:'second'});
    await expect(registry.dispatch({...input,job:{...input.job,attempts:2}})).rejects.toThrow('coverage crash');
    expect(tokens).toEqual([null,'second','second']);
    const result=await registry.dispatch({...input,job:{...input.job,attempts:3}});
    expect(tokens).toEqual([null,'second','second']);
    expect(result).toMatchObject({pages:2,sourceRows:2,loadedRows:2,verifiedLoadedRows:2,writtenRows:0,existingRows:2,observedAt:new Date(progress!.acquired_at).toISOString()});
    const coverage=await database.sql`select loaded_rows,status,observed_at from public.report_coverage where org_id=${scope.orgId} and report_type='amazon_change_history'`;
    expect(coverage).toHaveLength(1);expect(coverage[0]!['status']).toBe('complete');expect(Number(coverage[0]!['loaded_rows'])).toBe(2);
  } finally {await database.drop();}
},120_000);

it('clears post-persistence cursor failure on a verified replay with no new provider calls',async()=>{
  const database=await createTestDatabase('catalogue_status_replay');
  try {
    const [tenant]=await database.sql<{id:string}[]>`select app.seed_tenant_fixture('catalogue-status-replay',${orgId}::uuid) as id`;
    const [stored]=await database.sql<{id:string}[]>`select id from public.ad_profiles where org_id=${tenant!.id} limit 1`;
    const scope={orgId:tenant!.id,profileId:stored!.id,marketplaceId};
    const payload={...scope,type:'ads.product_metadata.sync' as const,sourceEnabled:true as const,asins:['B000TEST01'],adProduct:'SP' as const};
    const input=context(payload);input.profile={...profile,id:scope.profileId,orgId:scope.orgId};
    const client=fakeClient();let fail=true,clock=0;
    const runner=new CatalogueSourceRunner({handle:database,client,deploymentEnabled:()=>true,isEnabled:async()=>true,
      now:()=>new Date(Date.parse('2026-09-15T00:00:00.000Z')+clock++*1000),
      persistPage:async(handle,page)=>{
        const state=await persistCataloguePage(handle,page);
        if(state.result && fail){fail=false;throw new Error('synthetic crash after final persistence');}
        return state;
      }});
    await expect(runner.execute(await runner.plan(input))).rejects.toThrow('crash after final persistence');
    expect(client.getProductMetadataPage).toHaveBeenCalledTimes(1);
    const checkpoint=async()=>{
      const rows=await database.sql`select receipt_id,covered_from,covered_through,source_observed_at,cursor,cursor_failure
        from public.ads_catalogue_source_checkpoints where org_id=${scope.orgId} and profile_id=${scope.profileId}
        and marketplace_id=${scope.marketplaceId} and family='product_metadata'`;
      expect(rows).toHaveLength(1);return rows[0]!;
    };
    const failed=await checkpoint();
    expect(failed['cursor_failure']).toBe('catalogue source failed (Error)');
    const replay=await runner.execute(await runner.plan({...input,job:{...input.job,attempts:2}}));
    expect(client.getProductMetadataPage).toHaveBeenCalledTimes(1);
    expect(replay).toMatchObject({writtenRows:0,existingRows:1,verifiedLoadedRows:1,
      observedAt:new Date(failed['source_observed_at'] as Date).toISOString()});
    expect(await checkpoint()).toEqual({...failed,cursor_failure:null});
  } finally {await database.drop();}
},120_000);

it('keeps two marketplaces and two selectors independently complete or partial in WP-256',async()=>{
  const database=await createTestDatabase('catalogue_coverage_scope');
  try {
    const [tenant]=await database.sql<{id:string}[]>`select app.seed_tenant_fixture('catalogue-coverage',${orgId}::uuid) as id`;
    const [stored]=await database.sql<{id:string}[]>`select id from public.ad_profiles where org_id=${tenant!.id} limit 1`;
    const normal=fakeClient();
    const client=fakeClient({getProductMetadataPage:vi.fn(async(p,request)=>request.asins.includes('B000TEST01')?normal.getProductMetadataPage(p,request):{sourceRows:0,nextToken:null,rows:[]})});
    const runner=new CatalogueSourceRunner({handle:database,client,deploymentEnabled:()=>true,isEnabled:async()=>true,now:()=>new Date('2026-09-15T00:00:00.000Z')});
    const registry=new IngestionRegistry((observation,verified)=>upsertReportCoverage(database,observation,verified));registerCatalogueSources(registry,runner);
    let index=0;
    for(const market of ['MARKET-A','MARKET-B'])for(const asin of ['B000TEST01','B000TEST02']) {
      const payload={orgId:tenant!.id,profileId:stored!.id,marketplaceId:market,type:'ads.product_metadata.sync' as const,sourceEnabled:true as const,asins:[asin],adProduct:'SP' as const};
      const input=context(payload);input.profile={...profile,id:stored!.id,orgId:tenant!.id};input.job={...input.job,id:`44444444-4444-4444-8444-${String(++index).padStart(12,'0')}`,orgId:tenant!.id,profileId:stored!.id};
      await registry.dispatch({...input});
    }
    const coverage=await database.sql<{grain:string;status:string;loaded_rows:number}[]>`select grain,status,loaded_rows from public.report_coverage where org_id=${tenant!.id} and report_type='ads_product_metadata'`;
    expect(coverage).toHaveLength(4);expect(new Set(coverage.map(row=>row.grain)).size).toBe(4);
    expect(coverage.filter(row=>row.status==='complete')).toHaveLength(2);expect(coverage.filter(row=>row.status==='partial')).toHaveLength(2);
    expect(coverage.filter(row=>row.grain.includes('marketplace:MARKET-A:'))).toHaveLength(2);
    const checkpoints=await database.sql`select * from public.ads_catalogue_source_checkpoints where org_id=${tenant!.id} and marketplace_id in ('MARKET-A','MARKET-B')`;
    expect(checkpoints).toHaveLength(4);expect(checkpoints.filter(row=>row['covered_through']!==null)).toHaveLength(2);
  } finally {await database.drop();}
},120_000);

it('derives distinct placement identities and retains explicit ambiguity for collisions',async()=>{
  const base={entityType:'CAMPAIGN' as const,entityId:'987654321',changeType:'PLACEMENT_GROUP',timestamp:Date.parse('2026-09-14T10:00:00.000Z'),previousValue:'0',newValue:'10'};
  const h=harness(fakeClient({getChangeHistoryPage:vi.fn(async()=>({sourceRows:4,nextToken:null,rows:[
    {...base,metadata:{placementGroupPosition:'TOP_OF_SEARCH'}},
    {...base,metadata:{placementGroupPosition:'DETAIL_PAGE'}},
    {...base,newValue:'20',metadata:{placementGroupPosition:'TOP_OF_SEARCH'}},
    {...base,metadata:{placementGroupPosition:'DETAIL_PAGE'}},
  ]}))}));
  const result=await h.runner.execute(await h.runner.plan(context({type:'ads.change_history.sync',orgId,profileId,marketplaceId,sourceEnabled:true,from:'2026-09-14T00:00:00.000Z',to:'2026-09-15T00:00:00.000Z'})));
  expect(result).toMatchObject({sourceRows:4,duplicates:1,loadedRows:3});
  const events=h.persisted[0]!.rows.filter((row):row is Extract<typeof row,{sourceEventKey:string}>=>'sourceEventKey' in row);
  expect(events[0]!.sourceEventKey).not.toBe(events[1]!.sourceEventKey);expect(events[0]!.sourceEventKey).toBe(events[2]!.sourceEventKey);
  expect(events.every(row=>row.identityAmbiguity==='provider_id_unavailable')).toBe(true);
  const long=harness(fakeClient({getChangeHistoryPage:vi.fn(async()=>({sourceRows:2,nextToken:null,rows:['A','B'].map(suffix=>({...base,entityType:'PRODUCT_TARGETING' as const,changeType:'BID_AMOUNT',metadata:{targetingExpression:'x'.repeat(300)+suffix}}))}))}));
  await long.runner.execute(await long.runner.plan(context({type:'ads.change_history.sync',orgId,profileId,marketplaceId,sourceEnabled:true,from:'2026-09-14T00:00:00.000Z',to:'2026-09-15T00:00:00.000Z'})));
  const distinct=long.persisted[0]!.rows.filter((row):row is Extract<typeof row,{sourceEventKey:string}>=>'sourceEventKey' in row);
  expect(distinct).toHaveLength(2);expect(distinct[0]!.sourceEventKey).not.toBe(distinct[1]!.sourceEventKey);
  expect(distinct[0]!.metadata['targetingExpression']).toBe(distinct[1]!.metadata['targetingExpression']);
});

it('writes zero catalogue schedules while deployment or profile admission is disabled',async()=>{
  const database=await createTestDatabase('catalogue_provisioning');
  try {
    const [tenant]=await database.sql<{id:string}[]>`select app.seed_tenant_fixture('catalogue-provisioning',${orgId}::uuid) as id`;
    const [stored]=await database.sql<{id:string}[]>`select id from public.ad_profiles where org_id=${tenant!.id} limit 1`;
    const off=new PostgresWorkerStore(database),on=new PostgresWorkerStore(database,undefined,{catalogueDeploymentEnabled:()=>true});
    expect(await off.ensureCatalogueSchedules()).toBe(0);expect(await on.ensureCatalogueSchedules()).toBe(0);
    await database.sql`update public.ads_catalogue_source_settings set enabled=true,reporting_recovery_verified_at=now() where org_id=${tenant!.id} and family='product_metadata'`;
    await database.sql`update public.ad_profiles set sync_enabled=false where id=${stored!.id}`;
    expect(await on.ensureCatalogueSchedules()).toBe(0);
    await database.sql`update public.ad_profiles set sync_enabled=true where id=${stored!.id}`;
    expect(await off.ensureCatalogueSchedules()).toBe(0);
    const before=await database.sql`select id from public.sync_schedules where profile_id=${stored!.id} and variant like 'catalogue:%'`;expect(before).toHaveLength(0);
    expect(await on.ensureCatalogueSchedules()).toBe(1);expect(await on.ensureCatalogueSchedules()).toBe(0);
    const after=await database.sql`select enabled from public.sync_schedules where profile_id=${stored!.id} and variant like 'catalogue:%'`;expect(after).toHaveLength(1);expect(after[0]!['enabled']).toBe(false);
  } finally {await database.drop();}
},120_000);
