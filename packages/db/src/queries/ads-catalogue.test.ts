import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AmazonChangeEvent, ProductEligibilitySnapshot, ProductMetadataSnapshot, ValidationConfiguration } from '@wizard-ads/shared';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '../testing/harness.js';
import { catalogueDigest, catalogueSourceEnabled, recordCatalogueCursorFailure, persistCatalogueCollection, readAmazonObservedChanges, readProductEvidence, resolveAmazonChangeEvents, readCampaignProductEvidence, readCurrentValidationConfiguration, readCatalogueSourceStatus, resumeCatalogueAcquisition, persistCataloguePage, readAdvertisedCatalogueProducts } from './ads-catalogue.js';
import { listChangeQueue } from './time-machine.js';
import { readCreativeWorkspace } from './creative-workspace.js';
import { readTimeline } from './timeline.js';

let database: TestDatabase;
let orgId: string;
let profileId: string;
const marketplaceId='A1SYNTHETIC';
const userId='00000000-0000-4000-8000-000000000311';
const available=await databaseAvailable();
const at=(day:number)=>`2026-09-${String(day).padStart(2,'0')}T12:00:00.000Z`;

function metadata(marketplace:string,day:number,title:string|null='Synthetic title') {
  const field=(value:string|null)=>value===null?{state:'absent' as const,reason:null}:{state:'returned' as const,value,sourceField:'synthetic'};
  return ProductMetadataSnapshot.parse({scope:{orgId,profileId,marketplaceId:marketplace},asin:'B000TEST01',sku:null,adProduct:'SP',
    provenance:{family:'product_metadata',contractVersion:'product-metadata-v1-synthetic',providerObservedAt:null,acquiredAt:at(day),retrievedAt:at(day)},
    title:field(title),imageUrl:field(null),category:{state:'contradictory',reason:'synthetic conflicting category'},variationAsins:{state:'returned',value:[],sourceField:'variationList'},
    price:{state:'returned',value:{amount:0,currency:'EUR'},sourceField:'priceToPay'},basisPrice:{state:'absent',reason:null},availability:{state:'absent',reason:null},
    inventoryQuantity:{state:'absent',reason:'provider does not return inventory quantity'},bestSellerRank:{state:'returned',value:0,sourceField:'bestSellerRank'}});
}

async function persist(family:'product_metadata'|'product_eligibility'|'change_history',marketplace:string,day:number,rows:Parameters<typeof persistCatalogueCollection>[1]['rows']) {
  return persistCatalogueCollection(database,{scope:{orgId,profileId,marketplaceId:marketplace},family,selectorKey:`${family}-synthetic`,windowStart:at(day),windowEnd:at(day),acquiredAt:at(day),pages:1,finalCursor:null,sourceRows:rows.length,parsedRows:rows.length,refusedRows:0,duplicates:0,rows});
}

describe.skipIf(!available)('catalogue snapshots and Amazon event ledger',()=>{
  beforeAll(async()=>{database=await createTestDatabase('ads_catalogue');const seeded=await database.sql<{id:string}[]>`select app.seed_tenant_fixture('catalogue-alpha',${userId}::uuid) as id`;orgId=seeded[0]!.id;const rows=await database.sql<{profile_id:string}[]>`select id as profile_id from public.ad_profiles where org_id=${orgId} order by id limit 1`;profileId=rows[0]!.profile_id;},120_000);
  afterAll(async()=>database?.drop());

  it('defaults every source gate off and requires reporting recovery evidence',async()=>{
    await database.sql`insert into public.ads_catalogue_source_settings(org_id,profile_id,marketplace_id,family) values(${orgId},${profileId},${marketplaceId},'product_metadata')`;
    await expect(catalogueSourceEnabled(database,{orgId,profileId,marketplaceId},'product_metadata')).resolves.toBe(false);
    await database.sql`update public.ads_catalogue_source_settings set enabled=true where org_id=${orgId} and profile_id=${profileId}`;
    await expect(catalogueSourceEnabled(database,{orgId,profileId,marketplaceId},'product_metadata')).resolves.toBe(false);
    await database.sql`update public.ads_catalogue_source_settings set reporting_recovery_verified_at=now() where org_id=${orgId} and profile_id=${profileId}`;
    await expect(catalogueSourceEnabled(database,{orgId,profileId,marketplaceId},'product_metadata')).resolves.toBe(true);
  });

  it('keeps exact marketplace scope, field absence, zero values and the newest observation',async()=>{
    await persist('product_metadata',marketplaceId,14,[metadata(marketplaceId,14,'New title')]);
    await persist('product_metadata',marketplaceId,13,[metadata(marketplaceId,13,'Old title')]);
    await persist('product_metadata','A2SYNTHETIC',14,[metadata('A2SYNTHETIC',14,'Other market')]);
    const eligibility=ProductEligibilitySnapshot.parse({scope:{orgId,profileId,marketplaceId},asin:'B000TEST01',sku:null,adProduct:'SP',verdict:'ineligible',reasons:[{code:'SYNTHETIC_REASON',message:'Synthetic reason',severity:null}],provenance:{family:'product_eligibility',contractVersion:'product-eligibility-v1-synthetic',providerObservedAt:null,acquiredAt:at(14),retrievedAt:at(14)}});
    await persist('product_eligibility',marketplaceId,14,[eligibility]);
    const [evidence]=await readProductEvidence(database,{scope:{orgId,profileId,marketplaceId},asins:['B000TEST01'],adProduct:'SP',staleAfter:at(13)});
    expect(evidence).toMatchObject({availability:'measured',metadata:{title:{state:'returned',value:'New title'},price:{state:'returned',value:{amount:0}},bestSellerRank:{state:'returned',value:0},availability:{state:'absent'},category:{state:'contradictory'}},eligibility:{verdict:'ineligible',reasons:[{code:'SYNTHETIC_REASON'}]}});
    const [other]=await readProductEvidence(database,{scope:{orgId,profileId,marketplaceId:'A2SYNTHETIC'},asins:['B000TEST01'],adProduct:'SP',staleAfter:at(13)});
    expect(other).toMatchObject({availability:'partial',metadata:{title:{value:'Other market'}},eligibility:null});
    const [missing]=await readProductEvidence(database,{scope:{orgId,profileId,marketplaceId},asins:['B000TEST02'],adProduct:'SP',staleAfter:at(13)});
    expect(missing).toMatchObject({availability:'missing',metadata:null,eligibility:null});
  });

  it('makes complete receipt replay idempotent and preserves source time',async()=>{
    const row=metadata(marketplaceId,15,'Replay title');
    const first=await persist('product_metadata',marketplaceId,15,[row]);
    const replay=await persist('product_metadata',marketplaceId,15,[row]);
    expect(first.counts.writtenRows).toBe(1);
    expect(replay).toMatchObject({receiptId:first.receiptId,replayed:true,counts:{writtenRows:0,existingRows:1,verifiedRows:1}});
    const count=await database.sql<{count:string;acquired_at:string}[]>`select count(*)::text as count,min(acquired_at)::text as acquired_at from public.ads_product_metadata_snapshots where org_id=${orgId} and profile_id=${profileId} and marketplace_id=${marketplaceId} and acquired_at=${at(15)}`;
    expect(count[0]!.count).toBe('1');expect(new Date(count[0]!.acquired_at).toISOString()).toBe(at(15));
  });

  it('retains unresolved, resolved, conflicting and late provider observations without local actor authority',async()=>{
    const campaign=await database.sql<{amazon_id:string}[]>`select amazon_id from public.campaigns where org_id=${orgId} and profile_id=${profileId} order by amazon_id limit 1`;
    const base={scope:{orgId,profileId,marketplaceId},sourceNamespace:'amazon_ads_change_history_v1' as const,sourceEventKey:'a'.repeat(64),identityQuality:'derived' as const,entityType:'CAMPAIGN' as const,entityId:campaign[0]!.amazon_id,changeType:'BUDGET',occurredAt:at(10),metadata:{source:'synthetic'},provenance:{family:'change_history' as const,contractVersion:'change-history-v1-synthetic',providerObservedAt:at(10),acquiredAt:at(15),retrievedAt:at(15)}};
    const first=AmazonChangeEvent.parse({...base,previousValue:'1',newValue:'2'}),conflict=AmazonChangeEvent.parse({...base,previousValue:'1',newValue:'3'});
    const inserted=await persist('change_history',marketplaceId,12,[first,conflict]);
    expect(inserted.counts).toMatchObject({canonicalRows:2,writtenRows:2,existingRows:0,verifiedRows:2});
    const overlapping=await persistCatalogueCollection(database,{scope:{orgId,profileId,marketplaceId},family:'change_history',selectorKey:'overlap',windowStart:at(9),windowEnd:at(13),acquiredAt:at(13),pages:1,finalCursor:null,sourceRows:2,parsedRows:2,refusedRows:0,duplicates:0,rows:[first,conflict]});
    expect(overlapping.counts).toMatchObject({writtenRows:0,existingRows:2,verifiedRows:2});
    let changes=await readAmazonObservedChanges(database,{orgId,profileId,marketplaceId});
    expect(changes).toHaveLength(2);expect(changes.every((row)=>row.identityConflict&&row.occurredAt===at(10)&&row.retrievedAt===at(15))).toBe(true);
    expect(await resolveAmazonChangeEvents(database,{orgId,profileId})).toMatchObject({offered:2,written:2});
    changes=await readAmazonObservedChanges(database,{orgId,profileId,marketplaceId});expect(changes.every((row)=>row.resolvedAmazonId===campaign[0]!.amazon_id)).toBe(true);
    const queue=await listChangeQueue(database,{orgId,profileId,source:'amazon'});expect(queue).toHaveLength(3);expect(queue.every((row)=>row.source==='amazon'&&row.state==='observed'&&row.batchId===null&&row.reviewHref===null)).toBe(true);
    const timeline=await readTimeline(database,orgId,profileId);
    const providerEvents=timeline.events.filter((row)=>row.kind==='amazon_change');
    expect(providerEvents).toHaveLength(3);
    expect(providerEvents.every((row)=>row.actorId===null&&row.note.includes('no local actor or restore authority'))).toBe(true);
    const payload=await database.sql<{keys:string[]}[]>`select array(select jsonb_object_keys(sanitized_payload) order by 1) as keys from public.amazon_change_events where org_id=${orgId} and marketplace_id=${marketplaceId} limit 1`;
    expect(payload[0]!.keys).toEqual(['metadata','newValue','previousValue']);
  });

  it('retains partial evidence without advancing the covered window',async()=>{
    const scope={orgId,profileId,marketplaceId},selectorKey='partial-collection';
    const result=await persistCatalogueCollection(database,{scope,family:'product_metadata',selectorKey,
      windowStart:at(15),windowEnd:at(15),acquiredAt:at(15),pages:1,finalCursor:null,
      sourceRows:1,parsedRows:0,refusedRows:1,duplicates:0,rows:[metadata(marketplaceId,15,'Partial evidence')]});
    expect(result.counts).toMatchObject({writtenRows:1,verifiedRows:1,refusedRows:1});
    const checkpoints=await database.sql`select covered_through,cursor_failure from public.ads_catalogue_source_checkpoints where profile_id=${profileId} and selector_key=${selectorKey}`;
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0]).toMatchObject({covered_through:null,cursor_failure:'incomplete collection'});
  });

  it('enforces append-only evidence and scoped receipt ownership',async()=>{
    await expect(database.sql`update public.ads_product_metadata_snapshots set snapshot='{}'::jsonb where org_id=${orgId} and profile_id=${profileId}`).rejects.toThrow('append-only');
    const seeded=await database.sql<{id:string}[]>`select app.seed_tenant_fixture('catalogue-beta','00000000-0000-4000-8000-000000000312'::uuid) as id`;
    const other=await database.sql<{org_id:string;id:string}[]>`select org_id,id from public.ad_profiles where org_id=${seeded[0]!.id} limit 1`;
    const receipt=await database.sql<{id:string}[]>`select id from public.ads_catalogue_source_receipts where org_id=${orgId} and profile_id=${profileId} limit 1`;await expect(database.sql`insert into public.ads_product_metadata_snapshots(org_id,profile_id,marketplace_id,asin,ad_product,acquired_at,retrieved_at,contract_version,snapshot,payload_digest,receipt_id) values(${other[0]!.org_id},${other[0]!.id},${marketplaceId},'B000TEST09','SP',now(),now(),'synthetic','{}',${catalogueDigest({synthetic:true})},${receipt[0]!.id})`).rejects.toThrow();
  });
  it('rejects malformed and conflicting receipt replay before returning saved counts',async()=>{
    const row=metadata('REPLAY-BOUNDARY',15), scope=row.scope;
    const input={scope,family:'product_metadata' as const,selectorKey:'boundary',windowStart:at(15),windowEnd:at(15),acquiredAt:at(15),pages:1,finalCursor:null,sourceRows:1,parsedRows:1,refusedRows:0,duplicates:0,rows:[row]};
    await persistCatalogueCollection(database,input);
    await expect(persistCatalogueCollection(database,{...input,rows:[{scope} as ProductMetadataSnapshot]})).rejects.toThrow();
    await expect(persistCatalogueCollection(database,{...input,rows:[{...row,title:{state:'returned',value:'Changed replay',sourceField:'title'}}]})).rejects.toThrow('fingerprint');
    const replay=await persistCatalogueCollection(database,input);
    expect(replay.counts).toMatchObject({writtenRows:0,existingRows:1,verifiedRows:1});
    await database.sql`alter table public.ads_product_metadata_snapshots disable trigger ads_product_metadata_append_only`;
    try { await database.sql`delete from public.ads_product_metadata_snapshots where marketplace_id='REPLAY-BOUNDARY'`;
      await expect(persistCatalogueCollection(database,input)).rejects.toThrow('independent readback');
    } finally {await database.sql`alter table public.ads_product_metadata_snapshots enable trigger ads_product_metadata_append_only`;}
  });

  it('preserves A to B to A configuration observations, exact replay and older arrivals',async()=>{
    const scope={orgId,profileId,marketplaceId:'CONFIG-HISTORY'};
    const save=async(day:number,value:string,acquisitionId?:string)=>{
      const configuration={syntheticRule:value};
      const row=ValidationConfiguration.parse({scope,resource:'campaigns',countryCode:'DE',entityType:'SELLER',adProduct:'SP',providerVersion:null,contentDigest:catalogueDigest(configuration),configuration,
        provenance:{family:'validation_configurations',contractVersion:'synthetic-v1',providerObservedAt:null,acquiredAt:at(day),retrievedAt:at(16)}});
      return persistCatalogueCollection(database,{scope,...(acquisitionId?{acquisitionId}:{}),family:'validation_configurations',selectorKey:'rules',windowStart:at(day),windowEnd:at(day),acquiredAt:at(day),pages:1,finalCursor:null,sourceRows:1,parsedRows:1,refusedRows:0,duplicates:0,rows:[row]});
    };
    await save(11,'A');await save(12,'B');await save(13,'A');await save(10,'B');
    await save(13,'A','second-acquisition-at-same-time');
    expect((await save(13,'A')).counts).toMatchObject({writtenRows:0,existingRows:1,verifiedRows:1});
    const [count]=await database.sql<{contents:number;observations:number}[]>`select count(distinct c.id)::int as contents,count(o.id)::int as observations from public.ads_validation_configurations c join public.ads_validation_configuration_observations o on o.configuration_id=c.id where c.marketplace_id='CONFIG-HISTORY'`;
    expect(count).toEqual({contents:2,observations:5});
    const request={scope,resource:'campaigns' as const,countryCode:'DE',entityType:'SELLER' as const,adProduct:'SP' as const,staleAfter:at(12)};
    expect(await readCurrentValidationConfiguration(database,request)).toMatchObject({availability:'measured',configuration:{configuration:{syntheticRule:'A'},provenance:{acquiredAt:at(13)}}});
    expect(await readCurrentValidationConfiguration(database,{...request,staleAfter:at(14)})).toMatchObject({availability:'stale'});
    expect(await readCurrentValidationConfiguration(database,{...request,countryCode:'FR'})).toMatchObject({availability:'missing',configuration:null,candidates:[]});
  });

  it('classifies eight product combinations and exposes the tested builder handoff',async()=>{
    const market='READER-MATRIX',scope={orgId,profileId,marketplaceId:market};
    const asins=Array.from({length:8},(_,i)=>`SYNTHETIC${i}`);
    const absent={state:'refused' as const,reason:'Synthetic unavailable'};
    const noFacts=(index:number)=>({...metadata(market,15),asin:asins[index]!,title:absent,imageUrl:absent,category:absent,variationAsins:absent,price:absent,basisPrice:absent,availability:absent,inventoryQuantity:absent,bestSellerRank:absent});
    const facts=[noFacts(1),...[2,4,5,6,7].map(index=>({...metadata(market,index===6?12:15),asin:asins[index]!}))];
    const verdicts=[1,2,3,4,5,6,7].map(index=>ProductEligibilitySnapshot.parse({scope,asin:asins[index],sku:null,adProduct:'SP',verdict:index<3?'unknown':index===5?'ineligible':'eligible',reasons:[{code:'SYNTHETIC_REASON',message:`Reason ${index}`,severity:null}],provenance:{family:'product_eligibility',contractVersion:'synthetic-v1',providerObservedAt:null,acquiredAt:at(index===7?12:15),retrievedAt:at(15)}}));
    await persist('product_metadata',market,15,facts);await persist('product_eligibility',market,15,verdicts);
    const input={scope,asins,adProduct:'SP' as const,staleAfter:at(14)};
    const products=await readProductEvidence(database,input);
    expect(products).toHaveLength(8);
    expect(products.map(row=>row.availability)).toEqual(['missing','missing','partial','partial','measured','measured','stale','stale']);
    const handoff=await readCampaignProductEvidence(database,input);
    expect(handoff.products).toHaveLength(8);expect(handoff.checks).toHaveLength(8);
    expect(handoff.checks.map(row=>row.status)).toEqual(['unavailable','unavailable','unavailable','unavailable','eligible','ineligible','unavailable','unavailable']);
    expect(handoff.checks[5]!.reasons).toEqual(['Reason 5']);
    expect(handoff).toMatchObject({campaignCreationAuthority:false,assetModeration:'unknown'});
  });

  it('preserves SKU-specific and same-SKU conflicting eligibility instead of picking a UUID',async()=>{
    const market='SKU-MATRIX',scope={orgId,profileId,marketplaceId:market};
    await persist('product_metadata',market,15,[metadata(market,15)]);
    const rows=['sku-a','sku-b'].map((sku,index)=>ProductEligibilitySnapshot.parse({
      scope,asin:'B000TEST01',sku,adProduct:'SP',verdict:index===0?'eligible':'ineligible',reasons:[{code:`SKU_${index}`,message:null,severity:null}],provenance:{family:'product_eligibility',contractVersion:'synthetic-v1',providerObservedAt:null,acquiredAt:at(15),retrievedAt:at(15)}}));
    await persist('product_eligibility',market,15,rows);
    const input={scope,asins:['B000TEST01'],adProduct:'SP' as const,staleAfter:at(14)};
    const [ambiguous]=await readProductEvidence(database,input);
    expect(ambiguous).toMatchObject({availability:'partial',eligibility:null,eligibilityIdentity:'ambiguous'});expect(ambiguous!.eligibilityCandidates).toHaveLength(2);
    const [specific]=await readProductEvidence(database,{...input,sku:'sku-b'});
    expect(specific).toMatchObject({sku:'sku-b',eligibility:{verdict:'ineligible',reasons:[{code:'SKU_1'}]}});
    const conflict={...rows[0]!,verdict:'ineligible' as const};
    await persistCatalogueCollection(database,{scope,family:'product_eligibility',selectorKey:'conflicting-sku',windowStart:at(15),windowEnd:at(15),acquiredAt:at(15),pages:1,finalCursor:null,sourceRows:1,parsedRows:1,refusedRows:0,duplicates:0,rows:[conflict]});
    const [sameSku]=await readProductEvidence(database,{...input,sku:'sku-a'});
    expect(sameSku!.eligibilityCandidates).toHaveLength(2);expect(sameSku!.eligibilityIdentity).toBe('ambiguous');
    expect((await readCampaignProductEvidence(database,input)).checks[0]!.status).toBe('unavailable');
  });

  it('distinguishes absent receipt counts from a verified empty collection',async()=>{
    const scope={orgId,profileId,marketplaceId:'EMPTY-COUNTS'};
    await database.sql`insert into public.ads_catalogue_source_checkpoints(org_id,profile_id,marketplace_id,family,selector_key,cursor_failure) values(${orgId},${profileId},${scope.marketplaceId},'change_history','never-completed','synthetic cursor failure')`;
    await persistCatalogueCollection(database,{scope,family:'change_history',selectorKey:'empty-complete',windowStart:at(14),windowEnd:at(15),acquiredAt:at(15),pages:1,finalCursor:null,sourceRows:0,parsedRows:0,refusedRows:0,duplicates:0,rows:[]});
    const statuses=await readCatalogueSourceStatus(database,scope);expect(statuses).toHaveLength(2);
    expect(statuses.find(row=>row.selectorKey==='never-completed')).toMatchObject({sourceRows:null,loadedRows:null});
    expect(statuses.find(row=>row.selectorKey==='empty-complete')).toMatchObject({availability:'measured',sourceRows:0,loadedRows:0,coveredThrough:at(15)});
  });

  it('commits pages and continuations atomically and resumes a stable acquisition after crashes',async()=>{
    const scope={orgId,profileId,marketplaceId:'CRASH-MATRIX'},id=randomUUID();
    const request={id,scope,family:'product_metadata' as const,selectorKey:'crash',requestFingerprint:catalogueDigest({scope,id}),proposedAcquiredAt:at(15),windowStart:null,windowEnd:null,requestedMembers:2};
    let state=await resumeCatalogueAcquisition(database,request);
    const row={...metadata(scope.marketplaceId,15),asin:'CRASH00001'};
    const page={acquisition:state,expected:state.next!,next:{page:1,unit:0,token:'page-two'},rows:[row],sourceRows:1,parsedRows:1,refusedRows:0,duplicates:0};
    await database.sql`create function public.synthetic_page_crash() returns trigger language plpgsql as $$ begin raise exception 'synthetic crash before page commit'; end $$`;
    await database.sql`create trigger synthetic_page_crash before insert on public.ads_catalogue_pages for each row execute function public.synthetic_page_crash()`;
    try {await expect(persistCataloguePage(database,page)).rejects.toThrow('synthetic crash');} finally {await database.sql`drop trigger synthetic_page_crash on public.ads_catalogue_pages`;await database.sql`drop function public.synthetic_page_crash()`;}
    const [rolledBack]=await database.sql<{rows:number}[]>`select count(*)::int as rows from public.ads_product_metadata_snapshots where marketplace_id=${scope.marketplaceId}`;
    expect(rolledBack!.rows).toBe(0);
    state=await resumeCatalogueAcquisition(database,{...request,proposedAcquiredAt:at(16)});expect(state.next).toEqual({page:0,unit:0,token:null});expect(state.acquiredAt).toBe(at(15));
    state=await persistCataloguePage(database,page);expect(state.next).toEqual({page:1,unit:0,token:'page-two'});
    const [notPublished]=await readProductEvidence(database,{scope,asins:[row.asin],adProduct:'SP',staleAfter:at(14)});
    expect(notPublished!.availability).toBe('missing');
    state=await resumeCatalogueAcquisition(database,{...request,proposedAcquiredAt:at(16)});expect(state.next).toEqual({page:1,unit:0,token:'page-two'});expect(state.pages).toHaveLength(1);
    await expect(persistCataloguePage(database,{...page,rows:[{...row,title:{state:'returned',value:'Replay conflict',sourceField:'title'}}]})).rejects.toThrow('fingerprint');
    state=await persistCataloguePage(database,{acquisition:state,expected:state.next!,next:null,rows:[{...row,asin:'CRASH00002'}],sourceRows:1,parsedRows:1,refusedRows:0,duplicates:0});
    expect(state.result!.counts).toMatchObject({pages:2,sourceRows:2,canonicalRows:2,verifiedRows:2});
    const restart=await resumeCatalogueAcquisition(database,{...request,proposedAcquiredAt:at(16)});
    expect(restart.next).toBeNull();expect(restart.result).toMatchObject({replayed:true,counts:{writtenRows:0,existingRows:2,verifiedRows:2}});
    expect(await readProductEvidence(database,{scope,asins:['CRASH00001','CRASH00002'],adProduct:'SP',staleAfter:at(14)})).toHaveLength(2);
    await expect(resumeCatalogueAcquisition(database,{...request,requestFingerprint:catalogueDigest('changed')})).rejects.toThrow('fingerprint');
  });

  it('clears a reverified final receipt failure without advancing time or replacing newer status',async()=>{
    const scope={orgId,profileId,marketplaceId:'STATUS-RECOVERY'},selectorKey='status-recovery';
    const input={scope,family:'product_metadata' as const,selectorKey,
      windowStart:at(14),windowEnd:at(15),acquiredAt:at(15),pages:1,finalCursor:null,
      sourceRows:1,parsedRows:1,refusedRows:0,duplicates:0,rows:[metadata(scope.marketplaceId,15)]};
    const checkpoint=async()=>{
      const rows=await database.sql`select receipt_id,covered_from,covered_through,source_observed_at,cursor,cursor_failure
        from public.ads_catalogue_source_checkpoints where org_id=${orgId} and profile_id=${profileId}
        and marketplace_id=${scope.marketplaceId} and family=${input.family} and selector_key=${selectorKey}`;
      expect(rows).toHaveLength(1);
      return rows[0]!;
    };
    const original=await persistCatalogueCollection(database,input),before=await checkpoint();
    await recordCatalogueCursorFailure(database,scope,input.family,selectorKey,'synthetic post-commit failure');
    expect((await checkpoint())['cursor_failure']).toBe('synthetic post-commit failure');
    const replay=await persistCatalogueCollection(database,input);
    expect(replay).toMatchObject({receiptId:original.receiptId,replayed:true,counts:{writtenRows:0,existingRows:1,verifiedRows:1}});
    expect(await checkpoint()).toEqual(before);

    // A partial newer receipt leaves the old coverage pointer in place.
    const partial={...input,acquiredAt:at(16),windowEnd:at(16),parsedRows:0,refusedRows:1,rows:[metadata(scope.marketplaceId,16)]};
    await persistCatalogueCollection(database,partial);
    const newerPartial=await checkpoint();
    expect(newerPartial).toMatchObject({receipt_id:original.receiptId,cursor_failure:'incomplete collection'});
    await persistCatalogueCollection(database,input);
    expect(await checkpoint()).toEqual(newerPartial);
    await persistCatalogueCollection(database,partial);
    expect(await checkpoint()).toEqual(newerPartial);

    const complete={...input,acquiredAt:at(17),windowEnd:at(17),rows:[metadata(scope.marketplaceId,17)]};
    const newest=await persistCatalogueCollection(database,complete),newestBefore=await checkpoint();
    await recordCatalogueCursorFailure(database,scope,input.family,selectorKey,'synthetic latest failure');
    const newestFailed=await checkpoint();
    expect(newestFailed['receipt_id']).toBe(newest.receiptId);
    await persistCatalogueCollection(database,input);
    expect(await checkpoint()).toEqual(newestFailed);
    await persistCatalogueCollection(database,complete);
    expect(await checkpoint()).toEqual(newestBefore);

    // A newer acquisition can fail before it has a final receipt.
    const id=randomUUID();
    await resumeCatalogueAcquisition(database,{id,scope,family:input.family,selectorKey,
      requestFingerprint:catalogueDigest({id}),proposedAcquiredAt:at(18),windowStart:null,windowEnd:null,requestedMembers:1});
    await recordCatalogueCursorFailure(database,scope,input.family,selectorKey,'synthetic newer acquisition failure');
    const unfinished=await checkpoint();
    await persistCatalogueCollection(database,complete);
    expect(await checkpoint()).toEqual(unfinished);
  });

  it('counts scoped Products rows for owned advertised identities',async()=>{
    const result=await readAdvertisedCatalogueProducts(database,{orgId,profileId,staleAfter:at(14)});
    expect(result.advertisedIdentities).toBeGreaterThan(0);
    expect(result.scopedRows).toBe(result.products.length);
    expect(result.products.every(row=>row.scope.orgId===orgId&&row.scope.profileId===profileId)).toBe(true);
    const filtered=await readAdvertisedCatalogueProducts(database,{orgId,profileId,asin:'MISSING-ASIN',staleAfter:at(14)});
    expect(filtered).toMatchObject({advertisedIdentities:0,scopedRows:0,products:[]});
  });

  it('partitions adjacent listing history by SKU and retains explicit reader conflict evidence',async()=>{
    const market='CREATIVE-SKU',row=metadata(market,11);
    for(const day of [11,12]) {
      await persist('product_metadata',market,day,['sku-a','sku-b'].map(sku=>({...metadata(market,day,`${sku} day ${day}`),asin:'CREATIVE01',sku})));
    }
    const workspace=await readCreativeWorkspace(database,{orgId,profileId,from:'2026-09-01',to:'2026-09-20'});
    const listing=workspace.listingChanges.filter(change=>change.marketplaceId===row.scope.marketplaceId);
    expect(listing).toHaveLength(2);expect(listing.every(change=>change.previous.sku===change.current.sku)).toBe(true);
    const imported=await listChangeQueue(database,{orgId,profileId,source:'amazon'});
    expect(imported).toHaveLength(3);expect(imported.filter(change=>change.amazonObservation?.identityConflict)).toHaveLength(2);
    expect(imported.every(change=>change.amazonObservation?.resolution==='resolved' && change.amazonObservation.marketplaceId.length>0)).toBe(true);
  });

  it('reads a counted Products matrix through advertised-ASIN scope',async()=>{
    const [tenant]=await database.sql<{id:string}[]>`select app.seed_tenant_fixture('products-reader-matrix','00000000-0000-4000-8000-000000000319'::uuid) as id`;
    const [profile]=await database.sql<{id:string}[]>`select id from public.ad_profiles where org_id=${tenant!.id} limit 1`;
    const scope={orgId:tenant!.id,profileId:profile!.id,marketplaceId:'ATVPDKIKX0DER'};
    for(const asin of ['PRODUCT-0','PRODUCT-1','PRODUCT-2','PRODUCT-3']) await database.sql`insert into public.product_ads(org_id,profile_id,amazon_id,ad_product,state,campaign_id,ad_group_id,asin) values(${scope.orgId},${scope.profileId},${asin},'SP','enabled','c-1','ag-1',${asin})`;
    const rows=[1,2,3].map(index=>({...metadata(scope.marketplaceId,index===3?10:15),scope,asin:`PRODUCT-${index}`,
      ...(index===2?{price:{state:'absent' as const,reason:null},bestSellerRank:{state:'absent' as const,reason:null}}:{})}));
    await persistCatalogueCollection(database,{scope,family:'product_metadata',selectorKey:'products-matrix',windowStart:at(15),windowEnd:at(15),acquiredAt:at(15),pages:1,finalCursor:null,sourceRows:3,parsedRows:3,refusedRows:0,duplicates:0,rows});
    const result=await readAdvertisedCatalogueProducts(database,{orgId:scope.orgId,profileId:scope.profileId,staleAfter:at(14)});
    expect(result).toMatchObject({advertisedIdentities:5,scopedRows:5,truncated:false});expect(result.products).toHaveLength(5);
    const products=result.products.filter(row=>row.asin.startsWith('PRODUCT-'));expect(products).toHaveLength(4);
    expect(products.map(row=>row.metadataAvailability)).toEqual(['missing','measured','measured','stale']);
    expect(products[1]!.metadata!.price).toMatchObject({state:'returned',value:{amount:0}});
    expect(products[2]!.metadata!.price.state).toBe('absent');
  });

});
