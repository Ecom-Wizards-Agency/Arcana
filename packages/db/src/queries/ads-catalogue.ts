import { createHash, randomUUID } from 'node:crypto';
import {
  AmazonChangeEvent, CatalogueCollectionCounts, CatalogueReaderStatus, ProductEligibilitySnapshot,
  ProductEvidence, ProductMetadataSnapshot, ValidationConfiguration,
  AdsCatalogueScope, type AdsCatalogueFamily,
} from '@wizard-ads/shared';
import type postgres from 'postgres';
import type { QueryHandle } from '../client.js';

export type CatalogueEvidenceRow = ProductMetadataSnapshot | ProductEligibilitySnapshot | ValidationConfiguration | AmazonChangeEvent;
export interface PersistCatalogueCollectionInput {
  scope: AdsCatalogueScope; family: AdsCatalogueFamily; selectorKey: string;
  windowStart: string; windowEnd: string; acquiredAt: string; pages: number; finalCursor: string | null;
  sourceRows: number; parsedRows: number; refusedRows: number; duplicates: number; requestedMembers?: number;
  rows: readonly CatalogueEvidenceRow[];
}
export interface PersistCatalogueCollectionResult { receiptId: string; counts: CatalogueCollectionCounts }

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a],[b]) => a.localeCompare(b)).map(([key,item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function catalogueDigest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
function sameScope(scope: AdsCatalogueScope, row: CatalogueEvidenceRow): boolean { return row.scope.orgId === scope.orgId && row.scope.profileId === scope.profileId && row.scope.marketplaceId === scope.marketplaceId; }

export async function persistCatalogueCollection(handle: QueryHandle, raw: PersistCatalogueCollectionInput): Promise<PersistCatalogueCollectionResult> {
  const input = { ...raw, scope: AdsCatalogueScope.parse(raw.scope), family: raw.family };
  if (input.rows.some((row) => !sameScope(input.scope, row))) throw new Error('catalogue row is outside collection scope');
  if (input.sourceRows !== input.parsedRows + input.refusedRows) throw new Error('catalogue source counts do not reconcile');
  if (input.rows.length !== input.parsedRows + input.refusedRows - input.duplicates) throw new Error('catalogue canonical rows do not reconcile');
  const transaction = async (sql: postgres.TransactionSql): Promise<PersistCatalogueCollectionResult> => {
    const receiptId = randomUUID();
    const created=await sql<{id:string}[]>`insert into public.ads_catalogue_source_receipts(id,org_id,profile_id,marketplace_id,family,selector_key,window_start,window_end,acquired_at,counts,page_count,final_cursor)
      values(${receiptId},${input.scope.orgId},${input.scope.profileId},${input.scope.marketplaceId},${input.family},${input.selectorKey},${input.windowStart},${input.windowEnd},${input.acquiredAt},'{}'::jsonb,${input.pages},${input.finalCursor})
      on conflict(profile_id,marketplace_id,family,selector_key,window_start,window_end,acquired_at) do nothing returning id`;
    if(created.length===0){const replay=await sql<{id:string;counts:unknown}[]>`select id,counts from public.ads_catalogue_source_receipts where org_id=${input.scope.orgId} and profile_id=${input.scope.profileId} and marketplace_id=${input.scope.marketplaceId} and family=${input.family} and selector_key=${input.selectorKey} and window_start=${input.windowStart} and window_end=${input.windowEnd} and acquired_at=${input.acquiredAt}`;if(replay.length!==1)throw new Error('catalogue replay receipt readback failed');return{receiptId:replay[0]!.id,counts:CatalogueCollectionCounts.parse(replay[0]!.counts)};}
    let writtenRows = 0;
    for (const rawRow of input.rows) {
      if (input.family === 'product_metadata') {
        const row = ProductMetadataSnapshot.parse(rawRow), digest = catalogueDigest(row);
        const inserted = await sql<{ id: string }[]>`insert into public.ads_product_metadata_snapshots(org_id,profile_id,marketplace_id,asin,sku,ad_product,acquired_at,retrieved_at,provider_observed_at,contract_version,snapshot,payload_digest,receipt_id)
          values(${row.scope.orgId},${row.scope.profileId},${row.scope.marketplaceId},${row.asin},${row.sku},${row.adProduct},${row.provenance.acquiredAt},${row.provenance.retrievedAt},${row.provenance.providerObservedAt},${row.provenance.contractVersion},${JSON.stringify(row)}::jsonb,${digest},${receiptId}) on conflict do nothing returning id`;
        writtenRows += inserted.length;
      } else if (input.family === 'product_eligibility') {
        const row = ProductEligibilitySnapshot.parse(rawRow), digest = catalogueDigest(row);
        const inserted = await sql<{ id: string }[]>`insert into public.ads_product_eligibility_snapshots(org_id,profile_id,marketplace_id,asin,sku,ad_product,verdict,reasons,acquired_at,retrieved_at,provider_observed_at,contract_version,payload_digest,receipt_id)
          values(${row.scope.orgId},${row.scope.profileId},${row.scope.marketplaceId},${row.asin},${row.sku},${row.adProduct},${row.verdict},${JSON.stringify(row.reasons)}::jsonb,${row.provenance.acquiredAt},${row.provenance.retrievedAt},${row.provenance.providerObservedAt},${row.provenance.contractVersion},${digest},${receiptId}) on conflict do nothing returning id`;
        writtenRows += inserted.length;
      } else if (input.family === 'validation_configurations') {
        const row = ValidationConfiguration.parse(rawRow);
        const jsonConfiguration = JSON.parse(JSON.stringify(row.configuration));
        const inserted = await sql<{ id: string }[]>`insert into public.ads_validation_configurations(org_id,profile_id,marketplace_id,resource,country_code,entity_type,ad_product,provider_version,content_digest,configuration,acquired_at,retrieved_at,receipt_id)
          values(${row.scope.orgId},${row.scope.profileId},${row.scope.marketplaceId},${row.resource},${row.countryCode},${row.entityType},${row.adProduct},${row.providerVersion},${row.contentDigest},${JSON.stringify(jsonConfiguration)}::jsonb,${row.provenance.acquiredAt},${row.provenance.retrievedAt},${receiptId}) on conflict do nothing returning id`;
        writtenRows += inserted.length;
      } else {
        const row = AmazonChangeEvent.parse(rawRow), payload = { previousValue: row.previousValue, newValue: row.newValue, metadata: row.metadata }, digest = catalogueDigest(payload);
        const inserted = await sql<{ id: string }[]>`insert into public.amazon_change_events(org_id,profile_id,marketplace_id,source_namespace,source_event_key,identity_quality,payload_digest,entity_type,entity_id,change_type,occurred_at,retrieved_at,sanitized_payload,receipt_id)
          values(${row.scope.orgId},${row.scope.profileId},${row.scope.marketplaceId},${row.sourceNamespace},${row.sourceEventKey},${row.identityQuality},${digest},${row.entityType},${row.entityId},${row.changeType},${row.occurredAt},${row.provenance.retrievedAt},${JSON.stringify(payload)}::jsonb,${receiptId}) on conflict do nothing returning id`;
        writtenRows += inserted.length;
      }
    }
    const table = input.family === 'product_metadata' ? 'ads_product_metadata_snapshots' : input.family === 'product_eligibility' ? 'ads_product_eligibility_snapshots' : input.family === 'validation_configurations' ? 'ads_validation_configurations' : 'amazon_change_events';
    const verified = await sql<{ count: string }[]>`select count(*)::text as count from ${sql(table)} where receipt_id=${receiptId}`;
    const verifiedRows = Number(verified[0]?.count ?? -1), canonicalRows = input.rows.length, existingRows = canonicalRows - writtenRows;
    if (verifiedRows !== writtenRows) throw new Error(`catalogue destination readback expected ${writtenRows}, read ${verifiedRows}`);
    let reconciledRows = 0;
    for (const rawRow of input.rows) {
      if (input.family === 'product_metadata') {
        const row=ProductMetadataSnapshot.parse(rawRow),digest=catalogueDigest(row);
        const found=await sql<{found:boolean}[]>`select exists(select 1 from public.ads_product_metadata_snapshots where org_id=${row.scope.orgId} and profile_id=${row.scope.profileId} and marketplace_id=${row.scope.marketplaceId} and asin=${row.asin} and coalesce(sku,'')=coalesce(${row.sku},'') and ad_product=${row.adProduct} and acquired_at=${row.provenance.acquiredAt} and payload_digest=${digest}) as found`;
        if(found[0]?.found) reconciledRows++;
      } else if(input.family==='product_eligibility') {
        const row=ProductEligibilitySnapshot.parse(rawRow),digest=catalogueDigest(row);
        const found=await sql<{found:boolean}[]>`select exists(select 1 from public.ads_product_eligibility_snapshots where org_id=${row.scope.orgId} and profile_id=${row.scope.profileId} and marketplace_id=${row.scope.marketplaceId} and asin=${row.asin} and coalesce(sku,'')=coalesce(${row.sku},'') and ad_product=${row.adProduct} and acquired_at=${row.provenance.acquiredAt} and payload_digest=${digest}) as found`;
        if(found[0]?.found) reconciledRows++;
      } else if(input.family==='validation_configurations') {
        const row=ValidationConfiguration.parse(rawRow);
        const found=await sql<{found:boolean}[]>`select exists(select 1 from public.ads_validation_configurations where org_id=${row.scope.orgId} and profile_id=${row.scope.profileId} and marketplace_id=${row.scope.marketplaceId} and resource=${row.resource} and country_code=${row.countryCode} and entity_type=${row.entityType} and ad_product=${row.adProduct} and content_digest=${row.contentDigest}) as found`;
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
    await sql`update public.ads_catalogue_source_receipts set counts=${JSON.stringify(counts)}::jsonb where id=${receiptId}`;
    if (input.refusedRows === 0 && input.finalCursor === null) await sql`insert into public.ads_catalogue_source_checkpoints(org_id,profile_id,marketplace_id,family,selector_key,covered_from,covered_through,source_observed_at,receipt_id,cursor,cursor_failure)
      values(${input.scope.orgId},${input.scope.profileId},${input.scope.marketplaceId},${input.family},${input.selectorKey},${input.windowStart},${input.windowEnd},${input.acquiredAt},${receiptId},${input.finalCursor},null)
      on conflict(profile_id,marketplace_id,family,selector_key) do update set covered_from=least(ads_catalogue_source_checkpoints.covered_from,excluded.covered_from),covered_through=excluded.covered_through,source_observed_at=excluded.source_observed_at,receipt_id=excluded.receipt_id,cursor=excluded.cursor,cursor_failure=null,updated_at=now()
      where ads_catalogue_source_checkpoints.org_id=excluded.org_id and (ads_catalogue_source_checkpoints.source_observed_at is null or ads_catalogue_source_checkpoints.source_observed_at<=excluded.source_observed_at)`;
    if (input.refusedRows > 0 || input.finalCursor !== null) {
      await sql`insert into public.ads_catalogue_source_checkpoints(org_id,profile_id,marketplace_id,family,selector_key,cursor_failure)
        values(${input.scope.orgId},${input.scope.profileId},${input.scope.marketplaceId},${input.family},${input.selectorKey},'incomplete collection')
        on conflict(profile_id,marketplace_id,family,selector_key) do update set cursor_failure='incomplete collection',updated_at=now() where ads_catalogue_source_checkpoints.org_id=excluded.org_id`;
    }
    return { receiptId, counts };
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

export async function readProductEvidence(handle: QueryHandle, input: { scope: AdsCatalogueScope; asins: readonly string[]; adProduct: 'SP'|'SB'|'SD'; staleAfter: string }): Promise<ProductEvidence[]> {
  if (input.asins.length === 0) return [];
  const rows = await handle.sql<{ asin: string; metadata: unknown; eligibility: unknown; metadata_at: Date|string|null; eligibility_at: Date|string|null }[]>`
    select requested.asin,m.snapshot as metadata,
      case when e.id is null then null else jsonb_build_object('scope',jsonb_build_object('orgId',e.org_id,'profileId',e.profile_id,'marketplaceId',e.marketplace_id),'asin',e.asin,'sku',e.sku,'adProduct',e.ad_product,'verdict',e.verdict,'reasons',e.reasons,'provenance',jsonb_build_object('family','product_eligibility','contractVersion',e.contract_version,
        'providerObservedAt',case when e.provider_observed_at is null then null else to_char(e.provider_observed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
        'acquiredAt',to_char(e.acquired_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'retrievedAt',to_char(e.retrieved_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) end as eligibility,
      m.acquired_at as metadata_at,e.acquired_at as eligibility_at from unnest(${[...input.asins]}::text[]) requested(asin)
    left join lateral(select * from public.ads_product_metadata_snapshots where org_id=${input.scope.orgId} and profile_id=${input.scope.profileId} and marketplace_id=${input.scope.marketplaceId} and asin=requested.asin and ad_product=${input.adProduct} order by acquired_at desc,retrieved_at desc,id desc limit 1)m on true
    left join lateral(select * from public.ads_product_eligibility_snapshots where org_id=${input.scope.orgId} and profile_id=${input.scope.profileId} and marketplace_id=${input.scope.marketplaceId} and asin=requested.asin and ad_product=${input.adProduct} order by acquired_at desc,retrieved_at desc,id desc limit 1)e on true`;
  if (rows.length !== input.asins.length) throw new Error('product evidence read count mismatch');
  const stale = new Date(input.staleAfter).getTime();
  return rows.map((row) => ProductEvidence.parse({ scope: input.scope, asin: row.asin,
    availability: row.metadata === null && row.eligibility === null ? 'missing' : [row.metadata_at,row.eligibility_at].filter(Boolean).some((at) => new Date(at!).getTime() < stale) ? 'stale' : row.metadata === null || row.eligibility === null ? 'partial' : 'measured',
    metadata: row.metadata === null ? null : ProductMetadataSnapshot.parse(row.metadata), eligibility: row.eligibility === null ? null : ProductEligibilitySnapshot.parse(row.eligibility) }));
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
  const rows = await handle.sql<Array<{family:AdsCatalogueFamily;covered_from:Date|string|null;covered_through:Date|string|null;source_observed_at:Date|string|null;cursor_failure:string|null;source_rows:string|null;loaded_rows:string|null}>>`
    select c.family,c.covered_from,c.covered_through,c.source_observed_at,c.cursor_failure,r.counts->>'sourceRows' as source_rows,r.counts->>'verifiedRows' as loaded_rows from public.ads_catalogue_source_checkpoints c left join public.ads_catalogue_source_receipts r on r.id=c.receipt_id where c.org_id=${scope.orgId} and c.profile_id=${scope.profileId} and c.marketplace_id=${scope.marketplaceId} order by c.family`;
  return rows.map((row) => CatalogueReaderStatus.parse({ family:row.family,availability:row.cursor_failure?'partial':row.covered_through?'measured':'missing',coveredFrom:row.covered_from?new Date(row.covered_from).toISOString():null,coveredThrough:row.covered_through?new Date(row.covered_through).toISOString():null,observedAt:row.source_observed_at?new Date(row.source_observed_at).toISOString():null,sourceRows:Number(row.source_rows??0),loadedRows:Number(row.loaded_rows??0),cursorFailure:row.cursor_failure }));
}
