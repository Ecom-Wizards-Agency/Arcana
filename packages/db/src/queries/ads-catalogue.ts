import { createHash, randomUUID } from 'node:crypto';
import {
  AmazonChangeEvent, CatalogueCollectionCounts, CatalogueReaderStatus, ProductEligibilitySnapshot,
  ProductEvidence, ProductMetadataSnapshot, ValidationConfiguration,
  AdsCatalogueScope, CatalogueAcquisitionRequest, CataloguePosition, CampaignProductEvidence, ProductEvidenceRequest, type AdsCatalogueFamily,
} from '@wizard-ads/shared';
import type postgres from 'postgres';
import type { QueryHandle } from '../client.js';

export type CatalogueEvidenceRow = ProductMetadataSnapshot | ProductEligibilitySnapshot | ValidationConfiguration | AmazonChangeEvent;
export interface PersistCatalogueCollectionInput {
  scope: AdsCatalogueScope; family: AdsCatalogueFamily; selectorKey: string;
  windowStart: string; windowEnd: string; acquiredAt: string; pages: number; finalCursor: string | null;
  sourceRows: number; parsedRows: number; refusedRows: number; duplicates: number; requestedMembers?: number;
  rows: readonly CatalogueEvidenceRow[];
  checkpoint?: boolean;
  acquisitionId?: string;
}
export interface PersistCatalogueCollectionResult { receiptId: string; counts: CatalogueCollectionCounts; replayed?: boolean }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a],[b]) => a.localeCompare(b)).map(([key,item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function catalogueDigest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
/** Canonical destination membership ignores retrieval time, retaining original acquisition time. */
export function catalogueRowIdentity(row: CatalogueEvidenceRow): string {
  if ('sourceEventKey' in row) return catalogueDigest({key:row.sourceEventKey,previousValue:row.previousValue,newValue:row.newValue,metadata:row.metadata});
  return catalogueDigest({...row,provenance:{...row.provenance,retrievedAt:null}});
}
function sameScope(scope: AdsCatalogueScope, row: CatalogueEvidenceRow): boolean { return row.scope.orgId === scope.orgId && row.scope.profileId === scope.profileId && row.scope.marketplaceId === scope.marketplaceId; }

export async function persistCatalogueCollection(handle: QueryHandle, raw: PersistCatalogueCollectionInput): Promise<PersistCatalogueCollectionResult> {
  const schema = raw.family === 'product_metadata' ? ProductMetadataSnapshot : raw.family === 'product_eligibility' ? ProductEligibilitySnapshot : raw.family === 'validation_configurations' ? ValidationConfiguration : AmazonChangeEvent;
  const input = { ...raw, scope: AdsCatalogueScope.parse(raw.scope), rows: raw.rows.map(row => schema.parse(row)) };
  const fingerprint = catalogueDigest(input);
  const acquisitionKey = input.acquisitionId??catalogueDigest({scope:input.scope,family:input.family,selectorKey:input.selectorKey,windowStart:input.windowStart,windowEnd:input.windowEnd,acquiredAt:input.acquiredAt});
  CatalogueCollectionCounts.parse({requestedMembers:input.requestedMembers ?? input.sourceRows, pages:input.pages, sourceRows:input.sourceRows,parsedRows:input.parsedRows,refusedRows:input.refusedRows,duplicates:input.duplicates,canonicalRows:input.rows.length,writtenRows:input.rows.length,existingRows:0,verifiedRows:input.rows.length});
  if (input.rows.some((row) => !sameScope(input.scope, row))) throw new Error('catalogue row is outside collection scope');
  if (input.sourceRows !== input.parsedRows + input.refusedRows) throw new Error('catalogue source counts do not reconcile');
  if (input.rows.length !== input.parsedRows + input.refusedRows - input.duplicates) throw new Error('catalogue canonical rows do not reconcile');
  const transaction = async (sql: postgres.TransactionSql): Promise<PersistCatalogueCollectionResult> => {
    let receiptId: string = randomUUID();
    const created=await sql<{id:string}[]>`insert into public.ads_catalogue_source_receipts(id,org_id,profile_id,marketplace_id,family,selector_key,window_start,window_end,acquired_at,counts,page_count,final_cursor,collection_fingerprint,acquisition_key)
      values(${receiptId},${input.scope.orgId},${input.scope.profileId},${input.scope.marketplaceId},${input.family},${input.selectorKey},${input.windowStart},${input.windowEnd},${input.acquiredAt},'{}'::jsonb,${input.pages},${input.finalCursor},${fingerprint},${acquisitionKey})
      on conflict(profile_id,marketplace_id,family,selector_key,window_start,window_end,acquired_at,acquisition_key) do nothing returning id`;
    const replayed = created.length === 0;
    if (replayed) {
      const replay = await sql<{id:string;collection_fingerprint:string}[]>`select id,collection_fingerprint from public.ads_catalogue_source_receipts where org_id=${input.scope.orgId} and profile_id=${input.scope.profileId} and marketplace_id=${input.scope.marketplaceId} and family=${input.family} and selector_key=${input.selectorKey} and window_start=${input.windowStart} and window_end=${input.windowEnd} and acquired_at=${input.acquiredAt} and acquisition_key=${acquisitionKey}`;
      if(replay.length!==1 || replay[0]!.collection_fingerprint!==fingerprint) throw new Error('catalogue replay fingerprint mismatch');
      receiptId=replay[0]!.id;
    }
    let writtenRows = 0;
    if (!replayed) for (const rawRow of input.rows) {
      if (input.family === 'product_metadata') {
        const row = ProductMetadataSnapshot.parse(rawRow), digest = catalogueRowIdentity(row);
        const inserted = await sql<{ id: string }[]>`insert into public.ads_product_metadata_snapshots(org_id,profile_id,marketplace_id,asin,sku,ad_product,acquired_at,retrieved_at,provider_observed_at,contract_version,snapshot,payload_digest,receipt_id)
          values(${row.scope.orgId},${row.scope.profileId},${row.scope.marketplaceId},${row.asin},${row.sku},${row.adProduct},${row.provenance.acquiredAt},${row.provenance.retrievedAt},${row.provenance.providerObservedAt},${row.provenance.contractVersion},${JSON.stringify(row)}::jsonb,${digest},${receiptId}) on conflict do nothing returning id`;
        writtenRows += inserted.length;
      } else if (input.family === 'product_eligibility') {
        const row = ProductEligibilitySnapshot.parse(rawRow), digest = catalogueRowIdentity(row);
        const inserted = await sql<{ id: string }[]>`insert into public.ads_product_eligibility_snapshots(org_id,profile_id,marketplace_id,asin,sku,ad_product,verdict,reasons,acquired_at,retrieved_at,provider_observed_at,contract_version,payload_digest,receipt_id)
          values(${row.scope.orgId},${row.scope.profileId},${row.scope.marketplaceId},${row.asin},${row.sku},${row.adProduct},${row.verdict},${JSON.stringify(row.reasons)}::jsonb,${row.provenance.acquiredAt},${row.provenance.retrievedAt},${row.provenance.providerObservedAt},${row.provenance.contractVersion},${digest},${receiptId}) on conflict do nothing returning id`;
        writtenRows += inserted.length;
      } else if (input.family === 'validation_configurations') {
        const row = ValidationConfiguration.parse(rawRow);
        const jsonConfiguration = JSON.parse(JSON.stringify(row.configuration));
        await sql`insert into public.ads_validation_configurations(org_id,profile_id,marketplace_id,resource,country_code,entity_type,ad_product,provider_version,content_digest,configuration,acquired_at,retrieved_at,receipt_id)
          values(${row.scope.orgId},${row.scope.profileId},${row.scope.marketplaceId},${row.resource},${row.countryCode},${row.entityType},${row.adProduct},${row.providerVersion},${row.contentDigest},${JSON.stringify(jsonConfiguration)}::jsonb,${row.provenance.acquiredAt},${row.provenance.retrievedAt},${receiptId}) on conflict do nothing`;
        const contents=await sql<{id:string;configuration:unknown}[]>`select id,configuration from public.ads_validation_configurations where org_id=${row.scope.orgId} and profile_id=${row.scope.profileId} and marketplace_id=${row.scope.marketplaceId} and resource=${row.resource} and country_code=${row.countryCode} and entity_type=${row.entityType} and ad_product=${row.adProduct} and content_digest=${row.contentDigest}`;
        if(contents.length!==1 || catalogueDigest(contents[0]!.configuration)!==catalogueDigest(jsonConfiguration) || row.contentDigest!==catalogueDigest(jsonConfiguration)) throw new Error('configuration content digest mismatch');
        const inserted=await sql<{id:string}[]>`insert into public.ads_validation_configuration_observations(org_id,profile_id,configuration_id,acquisition_key,acquired_at,retrieved_at,provider_observed_at,contract_version,receipt_id)
          values(${row.scope.orgId},${row.scope.profileId},${contents[0]!.id},${acquisitionKey},${row.provenance.acquiredAt},${row.provenance.retrievedAt},${row.provenance.providerObservedAt},${row.provenance.contractVersion},${receiptId}) on conflict do nothing returning id`;
        writtenRows += inserted.length;
      } else {
        const row = AmazonChangeEvent.parse(rawRow), payload = { previousValue: row.previousValue, newValue: row.newValue, metadata: row.metadata }, digest = catalogueDigest(payload);
        const inserted = await sql<{ id: string }[]>`insert into public.amazon_change_events(org_id,profile_id,marketplace_id,source_namespace,source_event_key,identity_quality,payload_digest,entity_type,entity_id,change_type,occurred_at,retrieved_at,sanitized_payload,receipt_id)
          values(${row.scope.orgId},${row.scope.profileId},${row.scope.marketplaceId},${row.sourceNamespace},${row.sourceEventKey},${row.identityQuality},${digest},${row.entityType},${row.entityId},${row.changeType},${row.occurredAt},${row.provenance.retrievedAt},${JSON.stringify(payload)}::jsonb,${receiptId}) on conflict do nothing returning id`;
        writtenRows += inserted.length;
      }
    }
    const table = input.family === 'product_metadata' ? 'ads_product_metadata_snapshots' : input.family === 'product_eligibility' ? 'ads_product_eligibility_snapshots' : input.family === 'validation_configurations' ? 'ads_validation_configuration_observations' : 'amazon_change_events';
    const verified = await sql<{ count: string }[]>`select count(*)::text as count from ${sql(table)} where receipt_id=${receiptId}`;
    const verifiedRows = Number(verified[0]?.count ?? -1), canonicalRows = input.rows.length, existingRows = canonicalRows - writtenRows;
    if (!replayed && verifiedRows !== writtenRows) throw new Error(`catalogue destination readback expected ${writtenRows}, read ${verifiedRows}`);
    let reconciledRows = 0;
    for (const rawRow of input.rows) {
      if (input.family === 'product_metadata') {
        const row=ProductMetadataSnapshot.parse(rawRow),digest=catalogueRowIdentity(row);
        const found=await sql<{found:boolean}[]>`select exists(select 1 from public.ads_product_metadata_snapshots where org_id=${row.scope.orgId} and profile_id=${row.scope.profileId} and marketplace_id=${row.scope.marketplaceId} and asin=${row.asin} and coalesce(sku,'')=coalesce(${row.sku},'') and ad_product=${row.adProduct} and acquired_at=${row.provenance.acquiredAt} and payload_digest=${digest}) as found`;
        if(found[0]?.found) reconciledRows++;
      } else if(input.family==='product_eligibility') {
        const row=ProductEligibilitySnapshot.parse(rawRow),digest=catalogueRowIdentity(row);
        const found=await sql<{found:boolean}[]>`select exists(select 1 from public.ads_product_eligibility_snapshots where org_id=${row.scope.orgId} and profile_id=${row.scope.profileId} and marketplace_id=${row.scope.marketplaceId} and asin=${row.asin} and coalesce(sku,'')=coalesce(${row.sku},'') and ad_product=${row.adProduct} and acquired_at=${row.provenance.acquiredAt} and payload_digest=${digest}) as found`;
        if(found[0]?.found) reconciledRows++;
      } else if(input.family==='validation_configurations') {
        const row=ValidationConfiguration.parse(rawRow);
        const found=await sql<{found:boolean}[]>`select exists(select 1 from public.ads_validation_configurations c join public.ads_validation_configuration_observations o on o.configuration_id=c.id and o.org_id=c.org_id and o.profile_id=c.profile_id where c.org_id=${row.scope.orgId} and c.profile_id=${row.scope.profileId} and c.marketplace_id=${row.scope.marketplaceId} and c.resource=${row.resource} and c.country_code=${row.countryCode} and c.entity_type=${row.entityType} and c.ad_product=${row.adProduct} and c.content_digest=${row.contentDigest} and c.configuration=${JSON.stringify(row.configuration)}::jsonb and o.acquired_at=${row.provenance.acquiredAt} and o.acquisition_key=${acquisitionKey}) as found`;
        if(found[0]?.found) reconciledRows++;
      } else {
        const row=AmazonChangeEvent.parse(rawRow),digest=catalogueDigest({previousValue:row.previousValue,newValue:row.newValue,metadata:row.metadata});
        const found=await sql<{found:boolean}[]>`select exists(select 1 from public.amazon_change_events where org_id=${row.scope.orgId} and profile_id=${row.scope.profileId} and marketplace_id=${row.scope.marketplaceId} and source_namespace=${row.sourceNamespace} and source_event_key=${row.sourceEventKey} and payload_digest=${digest}) as found`;
        if(found[0]?.found) reconciledRows++;
      }
    }
    if(reconciledRows!==canonicalRows) throw new Error(`catalogue independent readback expected ${canonicalRows}, read ${reconciledRows}`);
    const counts = CatalogueCollectionCounts.parse({ requestedMembers: input.requestedMembers ?? input.sourceRows,
      pages: input.pages, sourceRows: input.sourceRows, parsedRows: input.parsedRows, refusedRows: input.refusedRows,
      duplicates: input.duplicates, canonicalRows, writtenRows, existingRows, verifiedRows: reconciledRows });
    if (!replayed) await sql`update public.ads_catalogue_source_receipts set counts=${JSON.stringify(counts)}::jsonb where id=${receiptId}`;
    // Reverification repairs only this receipt's failure marker; coverage and source age stay immutable.
    // A newer partial receipt or unfinished acquisition may still own the visible failure.
    if (input.checkpoint !== false && replayed && input.refusedRows === 0 && input.finalCursor === null) await sql`
      update public.ads_catalogue_source_checkpoints checkpoint set cursor_failure=null,updated_at=now()
      where checkpoint.org_id=${input.scope.orgId} and checkpoint.profile_id=${input.scope.profileId}
        and checkpoint.marketplace_id=${input.scope.marketplaceId} and checkpoint.family=${input.family}
        and checkpoint.selector_key=${input.selectorKey} and checkpoint.receipt_id=${receiptId}
        and checkpoint.source_observed_at=${input.acquiredAt} and checkpoint.cursor_failure is not null
        and not exists(select 1 from public.ads_catalogue_source_receipts newer
          where newer.org_id=checkpoint.org_id and newer.profile_id=checkpoint.profile_id
            and newer.marketplace_id=checkpoint.marketplace_id and newer.family=checkpoint.family
            and newer.selector_key=checkpoint.selector_key and newer.acquired_at>=${input.acquiredAt}
            and newer.id<>${receiptId})
        and not exists(select 1 from public.ads_catalogue_acquisitions newer
          where newer.org_id=checkpoint.org_id and newer.profile_id=checkpoint.profile_id
            and newer.marketplace_id=checkpoint.marketplace_id and newer.family=checkpoint.family
            and newer.selector_key=checkpoint.selector_key and newer.acquired_at>=${input.acquiredAt}
            and newer.final_receipt_id is distinct from ${receiptId}::uuid)`;
    if (input.checkpoint !== false && !replayed && input.refusedRows === 0 && input.finalCursor === null) await sql`insert into public.ads_catalogue_source_checkpoints(org_id,profile_id,marketplace_id,family,selector_key,covered_from,covered_through,source_observed_at,receipt_id,cursor,cursor_failure)
      values(${input.scope.orgId},${input.scope.profileId},${input.scope.marketplaceId},${input.family},${input.selectorKey},${input.windowStart},${input.windowEnd},${input.acquiredAt},${receiptId},${input.finalCursor},null)
      on conflict(profile_id,marketplace_id,family,selector_key) do update set covered_from=least(ads_catalogue_source_checkpoints.covered_from,excluded.covered_from),covered_through=excluded.covered_through,source_observed_at=excluded.source_observed_at,receipt_id=excluded.receipt_id,cursor=excluded.cursor,cursor_failure=null,updated_at=now()
      where ads_catalogue_source_checkpoints.org_id=excluded.org_id and (ads_catalogue_source_checkpoints.source_observed_at is null or ads_catalogue_source_checkpoints.source_observed_at<=excluded.source_observed_at)`;
    if (input.checkpoint !== false && !replayed && (input.refusedRows > 0 || input.finalCursor !== null)) {
      await sql`insert into public.ads_catalogue_source_checkpoints(org_id,profile_id,marketplace_id,family,selector_key,cursor_failure)
        values(${input.scope.orgId},${input.scope.profileId},${input.scope.marketplaceId},${input.family},${input.selectorKey},'incomplete collection')
        on conflict(profile_id,marketplace_id,family,selector_key) do update set cursor_failure='incomplete collection',updated_at=now() where ads_catalogue_source_checkpoints.org_id=excluded.org_id`;
    }
    return { receiptId, counts, replayed };
  };
  return 'savepoint' in handle.sql ? handle.sql.savepoint(transaction) : handle.sql.begin(transaction);
}

export async function catalogueSourceEnabled(handle: QueryHandle, scope: AdsCatalogueScope, family: AdsCatalogueFamily): Promise<boolean> {
  const rows = await handle.sql<{ enabled: boolean }[]>`select enabled and reporting_recovery_verified_at is not null as enabled from public.ads_catalogue_source_settings where org_id=${scope.orgId} and profile_id=${scope.profileId} and marketplace_id=${scope.marketplaceId} and family=${family}`;
  return rows.length === 1 && rows[0]!.enabled;
}

export async function recordCatalogueCursorFailure(handle: QueryHandle, scope: AdsCatalogueScope, family: AdsCatalogueFamily, selectorKey: string, message: string): Promise<void> {
  const bounded = message.slice(0, 240);
  await handle.sql`insert into public.ads_catalogue_source_checkpoints(org_id,profile_id,marketplace_id,family,selector_key,cursor_failure)
    values(${scope.orgId},${scope.profileId},${scope.marketplaceId},${family},${selectorKey},${bounded}) on conflict(profile_id,marketplace_id,family,selector_key) do update set cursor_failure=excluded.cursor_failure,updated_at=now() where ads_catalogue_source_checkpoints.org_id=excluded.org_id`;
}

export async function readProductEvidence(handle: QueryHandle, raw: ProductEvidenceRequest): Promise<ProductEvidence[]> {
  const input=ProductEvidenceRequest.parse(raw);
  if(input.asins.length===0) return [];
  const metadata=await handle.sql<{snapshot:unknown;collection_complete:boolean}[]>`with ranked as (
    select m.snapshot,m.asin,m.sku,m.acquired_at,
      (a.id is null or coalesce((final.counts->>'refusedRows')::int,1)=0) as collection_complete,
      dense_rank() over(partition by m.asin,coalesce(m.sku,'') order by m.acquired_at desc) as recency
    from public.ads_product_metadata_snapshots m join public.ads_catalogue_source_receipts r on r.id=m.receipt_id
    left join public.ads_catalogue_pages page on page.receipt_id=r.id
    left join public.ads_catalogue_acquisitions a on a.org_id=page.org_id and a.profile_id=page.profile_id and a.id=page.acquisition_id
    left join public.ads_catalogue_source_receipts final on final.id=a.final_receipt_id
    where m.org_id=${input.scope.orgId} and m.profile_id=${input.scope.profileId} and m.marketplace_id=${input.scope.marketplaceId}
      and m.asin=any(${input.asins}::text[]) and m.ad_product=${input.adProduct}
      and (${input.sku??null}::text is null or m.sku=${input.sku??null})
      and (r.selector_key not like 'acquisition:%' or a.final_receipt_id is not null))
    select snapshot,collection_complete from ranked where recency=1 order by asin,sku nulls first`;
  const eligibility=await handle.sql<{asin:string;sku:string|null;verdict:ProductEligibilitySnapshot['verdict'];reasons:ProductEligibilitySnapshot['reasons'];acquired_at:Date;retrieved_at:Date;provider_observed_at:Date|null;contract_version:string;collection_complete:boolean}[]>`with ranked as (
    select e.*, (a.id is null or coalesce((final.counts->>'refusedRows')::int,1)=0) as collection_complete,
      dense_rank() over(partition by e.asin,coalesce(e.sku,'') order by e.acquired_at desc) as recency
    from public.ads_product_eligibility_snapshots e join public.ads_catalogue_source_receipts r on r.id=e.receipt_id
    left join public.ads_catalogue_pages page on page.receipt_id=r.id
    left join public.ads_catalogue_acquisitions a on a.org_id=page.org_id and a.profile_id=page.profile_id and a.id=page.acquisition_id
    left join public.ads_catalogue_source_receipts final on final.id=a.final_receipt_id
    where e.org_id=${input.scope.orgId} and e.profile_id=${input.scope.profileId} and e.marketplace_id=${input.scope.marketplaceId}
      and e.asin=any(${input.asins}::text[]) and e.ad_product=${input.adProduct}
      and (${input.sku??null}::text is null or e.sku=${input.sku??null})
      and (r.selector_key not like 'acquisition:%' or a.final_receipt_id is not null))
    select * from ranked where recency=1 order by asin,sku nulls first,payload_digest`;
  const snapshots=metadata.map(row=>({snapshot:ProductMetadataSnapshot.parse(row.snapshot),complete:row.collection_complete}));
  const verdicts=eligibility.map(row=>({complete:row.collection_complete,snapshot:ProductEligibilitySnapshot.parse({scope:input.scope,asin:row.asin,sku:row.sku,adProduct:input.adProduct,verdict:row.verdict,reasons:row.reasons,
    provenance:{family:'product_eligibility',contractVersion:row.contract_version,providerObservedAt:row.provider_observed_at?new Date(row.provider_observed_at).toISOString():null,acquiredAt:new Date(row.acquired_at).toISOString(),retrievedAt:new Date(row.retrieved_at).toISOString()}})}));
  const stale=(row:ProductMetadataSnapshot|ProductEligibilitySnapshot)=>Date.parse(row.provenance.providerObservedAt??row.provenance.acquiredAt)<Date.parse(input.staleAfter);
  return input.asins.map(asin=>{
    const m=snapshots.filter(row=>row.snapshot.asin===asin),e=verdicts.filter(row=>row.snapshot.asin===asin);
    const facts=m.filter(row=>hasUsableProductFacts(row.snapshot));
    const explicit=e.filter(row=>row.snapshot.verdict!=='unknown');
    const metadataAvailability=facts.length===0?'missing':facts.some(row=>stale(row.snapshot))?'stale':m.length!==1||m.some(row=>!row.complete)?'partial':'measured';
    const eligibilityAvailability=explicit.length===0?'missing':explicit.some(row=>stale(row.snapshot))?'stale':e.length!==1||e.some(row=>!row.complete)?'partial':'measured';
    const availability=metadataAvailability==='stale'||eligibilityAvailability==='stale'?'stale':metadataAvailability==='measured'&&eligibilityAvailability==='measured'?'measured':facts.length===0&&explicit.length===0?'missing':'partial';
    return ProductEvidence.parse({scope:input.scope,asin,sku:input.sku??null,availability,metadataAvailability,eligibilityAvailability,
      metadata:m.length===1?m[0]!.snapshot:null,eligibility:e.length===1?e[0]!.snapshot:null,
      eligibilityIdentity:e.length===0?'missing':e.length===1?'explicit':'ambiguous',eligibilityCandidates:e.map(row=>row.snapshot)});
  });
}

export function hasUsableProductFacts(row:ProductMetadataSnapshot):boolean {
  return [row.title,row.imageUrl,row.category,row.variationAsins,row.price,row.basisPrice,row.availability,row.inventoryQuantity,row.bestSellerRank]
    .some(field=>field.state==='returned' && (typeof field.value==='string'?field.value.trim().length>0:Array.isArray(field.value)?field.value.length>0:true));
}

/** Future builder consumers must treat unavailable product checks as unavailable, with no write authority. */
export async function readCampaignProductEvidence(handle:QueryHandle,input:ProductEvidenceRequest):Promise<CampaignProductEvidence> {
  const products=await readProductEvidence(handle,input);
  return CampaignProductEvidence.parse({products,campaignCreationAuthority:false,assetModeration:'unknown',checks:products.map(product=>({asin:product.asin,
    status:product.availability!=='measured'||product.eligibilityIdentity!=='explicit'?'unavailable':product.eligibility?.verdict==='ineligible'?'ineligible':'eligible',
    reasons:product.eligibilityCandidates.flatMap(row=>row.reasons.map(reason=>reason.message??reason.code))}))});
}

export async function readCurrentValidationConfiguration(handle:QueryHandle,input:{scope:AdsCatalogueScope;resource:ValidationConfiguration['resource'];countryCode:string;entityType:ValidationConfiguration['entityType'];adProduct:ValidationConfiguration['adProduct'];staleAfter:string}):Promise<{availability:CatalogueReaderStatus['availability'];configuration:ValidationConfiguration|null;candidates:ValidationConfiguration[]}> {
  const rows=await handle.sql<{content:Record<string,unknown>;resource:string;country_code:string;entity_type:string;ad_product:string;content_digest:string;acquired_at:Date;retrieved_at:Date;provider_observed_at:Date|null;contract_version:string}[]>`with ranked as (
    select c.configuration as content,c.resource,c.country_code,c.entity_type,c.ad_product,c.content_digest,o.acquired_at,o.retrieved_at,o.provider_observed_at,o.contract_version,
      dense_rank() over(order by o.acquired_at desc) as recency
    from public.ads_validation_configurations c join public.ads_validation_configuration_observations o on o.configuration_id=c.id and o.org_id=c.org_id and o.profile_id=c.profile_id
    join public.ads_catalogue_source_receipts r on r.id=o.receipt_id
    left join public.ads_catalogue_pages page on page.receipt_id=r.id
    left join public.ads_catalogue_acquisitions a on a.org_id=page.org_id and a.profile_id=page.profile_id and a.id=page.acquisition_id
    where c.org_id=${input.scope.orgId} and c.profile_id=${input.scope.profileId} and c.marketplace_id=${input.scope.marketplaceId}
      and c.resource=${input.resource} and c.country_code=${input.countryCode} and c.entity_type=${input.entityType} and c.ad_product=${input.adProduct}
      and (r.selector_key not like 'acquisition:%' or a.final_receipt_id is not null)) select * from ranked where recency=1 order by content_digest`;
  const candidates=[...new Map(rows.map(row=>[row.content_digest,row])).values()].map(row=>ValidationConfiguration.parse({scope:input.scope,resource:row.resource,countryCode:row.country_code,entityType:row.entity_type,adProduct:row.ad_product,contentDigest:row.content_digest,configuration:row.content,providerVersion:null,
    provenance:{family:'validation_configurations',contractVersion:row.contract_version,acquiredAt:new Date(row.acquired_at).toISOString(),retrievedAt:new Date(row.retrieved_at).toISOString(),providerObservedAt:row.provider_observed_at?new Date(row.provider_observed_at).toISOString():null}}));
  return {availability:candidates.length===0?'missing':candidates.some(row=>Date.parse(row.provenance.acquiredAt)<Date.parse(input.staleAfter))?'stale':candidates.length>1?'partial':'measured',configuration:candidates.length===1?candidates[0]!:null,candidates};
}

export interface AmazonObservedChange { id: string; marketplaceId: string; occurredAt: string; retrievedAt: string; entityType: string; entityId: string; changeType: string; previousValue: string|null; newValue: string|null; resolvedEntityType: string|null; resolvedAmazonId: string|null; identityConflict: boolean; identityQuality: 'derived'; source: 'amazon_ads_change_history' }
export async function readAmazonObservedChanges(handle: QueryHandle, input: { orgId: string; profileId: string; marketplaceId?: string; from?: string; to?: string; limit?: number }): Promise<AmazonObservedChange[]> {
  const limit = Math.min(Math.max(input.limit ?? 100,1),500);
  const rows = await handle.sql<Array<{ id:string;marketplace_id:string;occurred_at:Date|string;retrieved_at:Date|string;entity_type:string;entity_id:string;change_type:string;payload:{previousValue?:string|null;newValue?:string|null};resolved_entity_type:string|null;resolved_amazon_id:string|null;identity_conflict:boolean;identity_quality:'derived' }>>`
    select e.id,e.marketplace_id,e.occurred_at,e.retrieved_at,e.entity_type,e.entity_id,e.change_type,e.sanitized_payload as payload,r.resolved_entity_type::text,r.resolved_amazon_id,
      exists(select 1 from public.amazon_change_events conflict where conflict.profile_id=e.profile_id and conflict.marketplace_id=e.marketplace_id and conflict.source_namespace=e.source_namespace and conflict.source_event_key=e.source_event_key and conflict.payload_digest<>e.payload_digest) as identity_conflict,e.identity_quality
    from public.amazon_change_events e left join lateral(select resolved_entity_type,resolved_amazon_id from public.amazon_change_event_resolutions where event_id=e.id order by resolved_at desc,id desc limit 1)r on true
    where e.org_id=${input.orgId} and e.profile_id=${input.profileId} and (${input.marketplaceId ?? null}::text is null or e.marketplace_id=${input.marketplaceId ?? null}) and (${input.from ?? null}::timestamptz is null or e.occurred_at>=${input.from ?? null}::timestamptz) and (${input.to ?? null}::timestamptz is null or e.occurred_at<=${input.to ?? null}::timestamptz) order by e.occurred_at desc,e.id desc limit ${limit}`;
  return rows.map((row) => ({ id: `amazon:${row.id}`, marketplaceId:row.marketplace_id, occurredAt: new Date(row.occurred_at).toISOString(), retrievedAt: new Date(row.retrieved_at).toISOString(), entityType: row.entity_type, entityId: row.entity_id, changeType: row.change_type, previousValue: row.payload.previousValue ?? null, newValue: row.payload.newValue ?? null, resolvedEntityType: row.resolved_entity_type, resolvedAmazonId: row.resolved_amazon_id, identityConflict: row.identity_conflict, identityQuality: row.identity_quality, source: 'amazon_ads_change_history' }));
}

export async function resolveAmazonChangeEvents(handle: QueryHandle, scope: { orgId:string;profileId:string }): Promise<{ offered:number;written:number;existing:number }> {
  const offered = await handle.sql<{ count:string }[]>`select count(*)::text as count from public.amazon_change_events e where e.org_id=${scope.orgId} and e.profile_id=${scope.profileId} and not exists(select 1 from public.amazon_change_event_resolutions r where r.event_id=e.id)`;
  const written = await handle.sql<{ id:string }[]>`with inventory as (
      select org_id,profile_id,'campaign'::public.entity_type as entity_type,amazon_id from public.campaigns union all
      select org_id,profile_id,'ad_group'::public.entity_type,amazon_id from public.ad_groups union all
      select org_id,profile_id,'product_ad'::public.entity_type,amazon_id from public.product_ads union all
      select org_id,profile_id,'keyword'::public.entity_type,amazon_id from public.keywords union all
      select org_id,profile_id,'target'::public.entity_type,amazon_id from public.targets union all
      select org_id,profile_id,'negative'::public.entity_type,amazon_id from public.negatives)
    insert into public.amazon_change_event_resolutions(org_id,profile_id,event_id,resolved_entity_type,resolved_amazon_id)
    select e.org_id,e.profile_id,e.id,case e.entity_type when 'CAMPAIGN' then 'campaign'::public.entity_type when 'AD_GROUP' then 'ad_group'::public.entity_type when 'AD' then 'product_ad'::public.entity_type when 'KEYWORD' then 'keyword'::public.entity_type when 'PRODUCT_TARGETING' then 'target'::public.entity_type else 'negative'::public.entity_type end,e.entity_id
    from public.amazon_change_events e where e.org_id=${scope.orgId} and e.profile_id=${scope.profileId} and exists(select 1 from inventory v where v.org_id=e.org_id and v.profile_id=e.profile_id and v.entity_type=case e.entity_type when 'CAMPAIGN' then 'campaign'::public.entity_type when 'AD_GROUP' then 'ad_group'::public.entity_type when 'AD' then 'product_ad'::public.entity_type when 'KEYWORD' then 'keyword'::public.entity_type when 'PRODUCT_TARGETING' then 'target'::public.entity_type else 'negative'::public.entity_type end and v.amazon_id=e.entity_id) on conflict do nothing returning id`;
  return { offered:Number(offered[0]?.count??0),written:written.length,existing:Number(offered[0]?.count??0)-written.length };
}

export async function readCatalogueSourceStatus(handle: QueryHandle, scope: AdsCatalogueScope): Promise<CatalogueReaderStatus[]> {
  const rows = await handle.sql<Array<{family:AdsCatalogueFamily;selector_key:string;covered_from:Date|string|null;covered_through:Date|string|null;source_observed_at:Date|string|null;cursor_failure:string|null;source_rows:string|null;loaded_rows:string|null}>>`
    select c.family,c.selector_key,c.covered_from,c.covered_through,c.source_observed_at,c.cursor_failure,r.counts->>'sourceRows' as source_rows,r.counts->>'verifiedRows' as loaded_rows from public.ads_catalogue_source_checkpoints c left join public.ads_catalogue_source_receipts r on r.id=c.receipt_id where c.org_id=${scope.orgId} and c.profile_id=${scope.profileId} and c.marketplace_id=${scope.marketplaceId} order by c.family`;
  return rows.map((row) => CatalogueReaderStatus.parse({ family:row.family,selectorKey:row.selector_key,availability:row.cursor_failure?'partial':row.covered_through?'measured':'missing',coveredFrom:row.covered_from?new Date(row.covered_from).toISOString():null,coveredThrough:row.covered_through?new Date(row.covered_through).toISOString():null,observedAt:row.source_observed_at?new Date(row.source_observed_at).toISOString():null,sourceRows:row.source_rows===null?null:Number(row.source_rows),loadedRows:row.loaded_rows===null?null:Number(row.loaded_rows),cursorFailure:row.cursor_failure }));
}

export interface CatalogueStoredPage {
  expected: CataloguePosition;
  next: CataloguePosition | null;
  evidence: PersistCatalogueCollectionInput;
}
export interface CatalogueAcquisitionState {
  request: CatalogueAcquisitionRequest;
  acquiredAt: string;
  windowStart: string;
  windowEnd: string;
  next: CataloguePosition | null;
  pages: CatalogueStoredPage[];
  result: PersistCatalogueCollectionResult | null;
  attemptWrittenRows: number;
}
export interface CataloguePageInput {
  acquisition: CatalogueAcquisitionState;
  expected: CataloguePosition;
  next: CataloguePosition | null;
  rows: readonly CatalogueEvidenceRow[];
  sourceRows: number;
  parsedRows: number;
  refusedRows: number;
  duplicates: number;
}

function collectionFromPages(state: CatalogueAcquisitionState): PersistCatalogueCollectionInput {
  const unique = new Map<string,CatalogueEvidenceRow>();
  let sourceRows=0, parsedRows=0, refusedRows=0, duplicates=0;
  for(const page of state.pages) {
    sourceRows+=page.evidence.sourceRows; parsedRows+=page.evidence.parsedRows;
    refusedRows+=page.evidence.refusedRows; duplicates+=page.evidence.duplicates;
    for(const row of page.evidence.rows) {
      const key=catalogueRowIdentity(row);
      if(unique.has(key)) duplicates++; else unique.set(key,row);
    }
  }
  return {scope:state.request.scope,family:state.request.family,selectorKey:state.request.selectorKey,acquisitionId:state.request.id,
    windowStart:state.windowStart,windowEnd:state.windowEnd,acquiredAt:state.acquiredAt,
    requestedMembers:state.request.requestedMembers,pages:state.pages.length,finalCursor:null,
    sourceRows,parsedRows,refusedRows,duplicates,rows:[...unique.values()]};
}

/** Job identity binds retries to one acquisition; completed retries reverify all destinations. */
export async function resumeCatalogueAcquisition(handle: QueryHandle, raw: CatalogueAcquisitionRequest): Promise<CatalogueAcquisitionState> {
  const request=CatalogueAcquisitionRequest.parse(raw);
  const scope=request.scope;
  const run=async(sql:postgres.TransactionSql):Promise<CatalogueAcquisitionState>=>{
    await sql`insert into public.ads_catalogue_acquisitions(id,org_id,profile_id,marketplace_id,family,selector_key,request_fingerprint,acquired_at,window_start,window_end,requested_members,next_position)
      values(${request.id},${scope.orgId},${scope.profileId},${scope.marketplaceId},${request.family},${request.selectorKey},${request.requestFingerprint},${request.proposedAcquiredAt},${request.windowStart??request.proposedAcquiredAt},${request.windowEnd??request.proposedAcquiredAt},${request.requestedMembers},'{"page":0,"unit":0,"token":null}'::jsonb) on conflict do nothing`;
    const [row]=await sql<{marketplace_id:string;family:string;selector_key:string;request_fingerprint:string;acquired_at:Date;window_start:Date;window_end:Date;next_position:unknown;requested_members:number}[]>`
      select * from public.ads_catalogue_acquisitions where org_id=${scope.orgId} and profile_id=${scope.profileId} and id=${request.id} for update`;
    if(!row || row.request_fingerprint!==request.requestFingerprint || row.marketplace_id!==scope.marketplaceId || row.family!==request.family || row.selector_key!==request.selectorKey || row.requested_members!==request.requestedMembers) throw new Error('catalogue acquisition request fingerprint mismatch');
    if(request.windowStart!==null && new Date(row.window_start).getTime()!==Date.parse(request.windowStart) || request.windowEnd!==null && new Date(row.window_end).getTime()!==Date.parse(request.windowEnd)) throw new Error('catalogue acquisition window mismatch');
    const saved=await sql<{expected_position:CataloguePosition;next_position:CataloguePosition|null;evidence:PersistCatalogueCollectionInput;page_number:number;page_fingerprint:string}[]>`
      select * from public.ads_catalogue_pages where org_id=${scope.orgId} and profile_id=${scope.profileId} and acquisition_id=${request.id} order by page_number`;
    let expected:CataloguePosition|null={page:0,unit:0,token:null};
    const state:CatalogueAcquisitionState={request,acquiredAt:new Date(row.acquired_at).toISOString(),windowStart:new Date(row.window_start).toISOString(),windowEnd:new Date(row.window_end).toISOString(),next:row.next_position===null?null:CataloguePosition.parse(row.next_position),pages:[],result:null,attemptWrittenRows:0};
    for(const page of saved) {
      if(page.page_number!==state.pages.length || canonical(page.expected_position)!==canonical(expected)) throw new Error('catalogue page sequence is incomplete');
      const entry={expected:CataloguePosition.parse(page.expected_position),next:page.next_position===null?null:CataloguePosition.parse(page.next_position),evidence:page.evidence};
      if(catalogueDigest(entry)!==page.page_fingerprint) throw new Error('catalogue page fingerprint mismatch');
      await persistCatalogueCollection({...handle,sql},page.evidence);
      state.pages.push(entry);expected=entry.next;
    }
    if(canonical(expected)!==canonical(state.next)) throw new Error('catalogue continuation differs from durable pages');
    if(state.next===null) state.result=await persistCatalogueCollection({...handle,sql},collectionFromPages(state));
    return state;
  };
  return 'savepoint' in handle.sql ? handle.sql.savepoint(run) : handle.sql.begin(run);
}

/** Destination readback, page evidence and continuation advance share one transaction. */
export async function persistCataloguePage(handle:QueryHandle, input:CataloguePageInput):Promise<CatalogueAcquisitionState> {
  const expected=CataloguePosition.parse(input.expected), next=input.next===null?null:CataloguePosition.parse(input.next);
  if(next!==null && (next.page!==expected.page+1 || next.unit<expected.unit || next.unit>expected.unit+1)) throw new Error('catalogue continuation is not adjacent');
  const run=async(sql:postgres.TransactionSql):Promise<CatalogueAcquisitionState>=>{
    const state=await resumeCatalogueAcquisition({...handle,sql},input.acquisition.request);
    const page:CatalogueStoredPage={expected,next,evidence:{scope:state.request.scope,family:state.request.family,
      selectorKey:`acquisition:${state.request.id}:page:${expected.page}`,acquisitionId:state.request.id,windowStart:state.windowStart,windowEnd:state.windowEnd,
      acquiredAt:state.acquiredAt,pages:1,finalCursor:next===null?null:JSON.stringify(next),requestedMembers:0,
      rows:input.rows,sourceRows:input.sourceRows,parsedRows:input.parsedRows,refusedRows:input.refusedRows,duplicates:input.duplicates,checkpoint:false}};
    if(input.rows.some(row=>row.provenance.acquiredAt!==state.acquiredAt && state.request.family!=='change_history')) throw new Error('catalogue page acquisition time mismatch');
    const fingerprint=catalogueDigest(page);
    const existing=state.pages[expected.page];
    if(existing) {
      if(catalogueDigest(existing)!==fingerprint) throw new Error('catalogue page replay fingerprint mismatch');
      await persistCatalogueCollection({...handle,sql},page.evidence);
      return state;
    }
    if(canonical(state.next)!==canonical(expected)) throw new Error('catalogue page position conflict');
    if(next?.token && state.pages.some(p=>p.expected.unit===next.unit && p.expected.token===next.token) || next?.token && next.unit===expected.unit && next.token===expected.token) throw new Error('catalogue cursor repeated');
    const persisted=await persistCatalogueCollection({...handle,sql},page.evidence);
    await sql`insert into public.ads_catalogue_pages(org_id,profile_id,acquisition_id,page_number,expected_position,next_position,page_fingerprint,evidence,receipt_id)
      values(${state.request.scope.orgId},${state.request.scope.profileId},${state.request.id},${expected.page},${JSON.stringify(expected)}::jsonb,${next===null?null:JSON.stringify(next)}::jsonb,${fingerprint},${JSON.stringify(page.evidence)}::jsonb,${persisted.receiptId})`;
    state.pages.push(page);state.next=next;state.attemptWrittenRows=persisted.counts.writtenRows;
    if(next===null) state.result=await persistCatalogueCollection({...handle,sql},collectionFromPages(state));
    await sql`update public.ads_catalogue_acquisitions set next_position=${next===null?null:JSON.stringify(next)}::jsonb,final_receipt_id=${state.result?.receiptId??null}
      where org_id=${state.request.scope.orgId} and profile_id=${state.request.scope.profileId} and id=${state.request.id}`;
    return state;
  };
  return 'savepoint' in handle.sql ? handle.sql.savepoint(run) : handle.sql.begin(run);
}

/** Bounded Products read; scope-less ASINs remain visible as unavailable. */
export async function readAdvertisedCatalogueProducts(handle:QueryHandle,input:{orgId:string;profileId:string;asin?:string;staleAfter:string}) {
  const own=await handle.sql<{asin:string;ad_product:ProductEvidenceRequest['adProduct']}[]>`select distinct asin,ad_product from public.product_ads
    where org_id=${input.orgId} and profile_id=${input.profileId} and deleted_at is null and asin is not null
      and (${input.asin??null}::text is null or asin=${input.asin??null}) order by asin,ad_product limit 301`;
  const selected=own.slice(0,300);
  const markets=await handle.sql<{marketplace_id:string}[]>`select distinct marketplace_id from (
    select marketplace_id from public.ads_catalogue_source_settings where org_id=${input.orgId} and profile_id=${input.profileId}
    union select marketplace_id from public.ads_product_metadata_snapshots where org_id=${input.orgId} and profile_id=${input.profileId}
    union select marketplace_id from public.ads_product_eligibility_snapshots where org_id=${input.orgId} and profile_id=${input.profileId}) scope order by marketplace_id`;
  const products:ProductEvidence[]=[];
  for(const market of markets) for(const adProduct of ['SP','SB','SD'] as const) {
    const asins=selected.filter(row=>row.ad_product===adProduct).map(row=>row.asin);
    products.push(...await readProductEvidence(handle,{scope:{orgId:input.orgId,profileId:input.profileId,marketplaceId:market.marketplace_id},asins,adProduct,staleAfter:input.staleAfter}));
  }
  if(products.length!==selected.length*markets.length) throw new Error('Products scoped evidence row count mismatch');
  return {products,missingScopeAsins:markets.length===0?selected.map(row=>row.asin):[],advertisedIdentities:selected.length,scopedRows:products.length,truncated:own.length>selected.length};
}
