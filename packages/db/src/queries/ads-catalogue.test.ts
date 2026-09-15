import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AmazonChangeEvent, ProductEligibilitySnapshot, ProductMetadataSnapshot } from '@wizard-ads/shared';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '../testing/harness.js';
import { catalogueDigest, catalogueSourceEnabled, persistCatalogueCollection, readAmazonObservedChanges, readProductEvidence, resolveAmazonChangeEvents } from './ads-catalogue.js';
import { listChangeQueue } from './time-machine.js';
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
    expect(replay).toEqual(first);
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
});
