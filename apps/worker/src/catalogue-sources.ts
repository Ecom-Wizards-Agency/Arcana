import { batchValues, PRODUCT_ELIGIBILITY_BATCH_SIZE, PRODUCT_METADATA_BATCH_SIZE, type ChangeHistoryRow, type ProductEligibilityRow, type ProductMetadataRow } from '@wizard-ads/ads-api';
import { catalogueDigest, catalogueRowIdentity, catalogueSourceEnabled, persistCataloguePage, resumeCatalogueAcquisition, recordCatalogueCursorFailure, type CatalogueAcquisitionState, type CatalogueEvidenceRow, type QueryHandle } from '@wizard-ads/db';
import { AmazonChangeEvent, ProductEligibilitySnapshot, ProductMetadataSnapshot, ValidationConfiguration, type AdsCatalogueFamily, type AdsCatalogueScope, type JobPayload, type CatalogueAcquisitionRequest, type CataloguePosition } from '@wizard-ads/shared';
import type { CatalogueAdsClient } from './ads-api.js';
import { ingestionSource } from './ingestion-sources.js';
import type { CoverageTarget, IngestionContext, IngestionRegistry } from './ingestion-registry.js';
import { PermanentJobError } from './permanent-job-error.js';

type CatalogueJob = Extract<JobPayload, { type: 'ads.product_metadata.sync'|'ads.product_eligibility.sync'|'ads.validation_configurations.sync'|'ads.change_history.sync' }>;
interface CatalogueRunResult extends Record<string, unknown> { family: AdsCatalogueFamily; observedAt: string; windowStart: string; windowEnd: string; requestedMembers: number; sourceRows: number; parsedRows: number; refusedRows: number; loadedRows: number; verifiedLoadedRows: number; pages: number; duplicates: number; writtenRows: number; existingRows: number; coverageGrain: string }
interface CataloguePlan { context: IngestionContext<CatalogueJob['type']>; scope: AdsCatalogueScope; family: AdsCatalogueFamily; selectorKey: string; acquiredAt: string; request: CatalogueAcquisitionRequest }

const FAMILY_BY_JOB: Record<CatalogueJob['type'], AdsCatalogueFamily> = {
  'ads.product_metadata.sync':'product_metadata', 'ads.product_eligibility.sync':'product_eligibility',
  'ads.validation_configurations.sync':'validation_configurations', 'ads.change_history.sync':'change_history',
};
const REPORT_TYPE_BY_FAMILY: Record<AdsCatalogueFamily,string> = {
  product_metadata:'ads_product_metadata', product_eligibility:'ads_product_eligibility',
  validation_configurations:'ads_validation_configurations', change_history:'amazon_change_history',
};
const day = (value:string) => value.slice(0,10);
function provenance(family: AdsCatalogueFamily, acquiredAt: string, retrievedAt: string) { return { family, contractVersion: `${family}:v1:openapi-3.0:2026-09-15`, providerObservedAt:null, acquiredAt, retrievedAt }; }
function absent(reason: string|null = null) { return { state:'absent' as const, reason }; }
function stringField(value:string|null, sourceField:string) { return value === null ? absent() : { state:'returned' as const,value,sourceField }; }
function numberField(value:number|null, sourceField:string) { return value === null ? absent() : { state:'returned' as const,value,sourceField }; }
function moneyField(value:{amount:number;currency:string}|null, sourceField:string) { return value === null ? absent() : { state:'returned' as const,value,sourceField }; }
function imageField(value:string|null) { if (value === null) return absent(); try { const url=new URL(value); if (url.search || /x-amz-|signature/i.test(value)) return absent('expiring signed URL is not durable asset identity'); return { state:'returned' as const,value,sourceField:'imageUrl' }; } catch { return absent('provider image URL is invalid'); } }
function metadataSnapshot(scope:AdsCatalogueScope,adProduct:'SP'|'SB'|'SD',row:ProductMetadataRow,acquiredAt:string,retrievedAt:string) { return ProductMetadataSnapshot.parse({ scope,asin:row.asin,sku:row.sku,adProduct,provenance:provenance('product_metadata',acquiredAt,retrievedAt),title:stringField(row.title,'title'),imageUrl:imageField(row.imageUrl),category:stringField(row.category,'category'),variationAsins:row.variationList===null?absent():{state:'returned',value:row.variationList,sourceField:'variationList'},price:moneyField(row.priceToPay,'priceToPay'),basisPrice:moneyField(row.basisPrice,'basisPrice'),availability:stringField(row.availability,'availability'),inventoryQuantity:absent('provider does not return inventory quantity'),bestSellerRank:numberField(row.bestSellerRank,'bestSellerRank') }); }
function unavailableMetadata(scope:AdsCatalogueScope,adProduct:'SP'|'SB'|'SD',asin:string,acquiredAt:string,retrievedAt:string) { const unavailable={state:'refused' as const,reason:'requested ASIN was absent from provider response'}; return ProductMetadataSnapshot.parse({scope,asin,sku:null,adProduct,provenance:provenance('product_metadata',acquiredAt,retrievedAt),title:unavailable,imageUrl:unavailable,category:unavailable,variationAsins:unavailable,price:unavailable,basisPrice:unavailable,availability:unavailable,inventoryQuantity:unavailable,bestSellerRank:unavailable}); }
function eligibilitySnapshot(scope:AdsCatalogueScope,adProduct:'SP'|'SB'|'SD',row:ProductEligibilityRow,acquiredAt:string,retrievedAt:string) { const verdict={ELIGIBLE:'eligible',ELIGIBLE_WITH_WARNING:'eligible_with_warning',INELIGIBLE:'ineligible'}[row.overallStatus]; return ProductEligibilitySnapshot.parse({scope,asin:row.asin,sku:row.sku,adProduct,verdict,reasons:row.reasons,provenance:provenance('product_eligibility',acquiredAt,retrievedAt)}); }
function unavailableEligibility(scope:AdsCatalogueScope,adProduct:'SP'|'SB'|'SD',asin:string,acquiredAt:string,retrievedAt:string) { return ProductEligibilitySnapshot.parse({scope,asin,sku:null,adProduct,verdict:'unknown',reasons:[{code:'PROVIDER_RESPONSE_MISSING',message:'Requested ASIN was absent from provider response',severity:null}],provenance:provenance('product_eligibility',acquiredAt,retrievedAt)}); }
function historyEvent(scope:AdsCatalogueScope,row:ChangeHistoryRow,retrievedAt:string) { if (row.timestamp < 1_000_000_000_000) throw new PermanentJobError('Change History timestamp unit is not documented as milliseconds'); const occurredAt=new Date(row.timestamp).toISOString(); const discriminatorKeys=['adGroupId','campaignBudgetType','campaignId','keyword','keywordType','negativeTargetingType','placementGroupPosition','predefinedTarget','productTargetingType','targetingExpression']; const discriminators=Object.fromEntries(discriminatorKeys.filter(key=>row.metadata[key]!==undefined).map(key=>[key,row.metadata[key]])); const sourceEventKey=catalogueDigest({scope,entityType:row.entityType,entityId:row.entityId,changeType:row.changeType,timestamp:row.timestamp,discriminators}); const metadata=Object.fromEntries(Object.entries(row.metadata).filter(([key])=>/^[A-Za-z0-9_.-]{1,64}$/.test(key)).slice(0,20).map(([key,value])=>[key,value.slice(0,256)])); return AmazonChangeEvent.parse({scope,sourceNamespace:'amazon_ads_change_history_v1',sourceEventKey,identityQuality:'derived',entityType:row.entityType,entityId:row.entityId,changeType:row.changeType,occurredAt,previousValue:row.previousValue,newValue:row.newValue,metadata,provenance:{...provenance('change_history',occurredAt,retrievedAt),providerObservedAt:occurredAt}}); }
function uniqueRows<T>(rows:readonly T[], key:(row:T)=>string): {rows:T[];duplicates:number} { const seen=new Set<string>(), kept:T[]=[]; let duplicates=0; for(const row of rows){const id=key(row);if(seen.has(id)){duplicates++;continue;}seen.add(id);kept.push(row);}return{rows:kept,duplicates}; }

export class CatalogueSourceRunner {
  constructor(private readonly deps: {
    handle: QueryHandle; client: CatalogueAdsClient | undefined; deploymentEnabled: () => boolean; now?: () => Date;
    isEnabled?: (scope: AdsCatalogueScope, family: AdsCatalogueFamily) => Promise<boolean>;
    resume?: typeof resumeCatalogueAcquisition; persistPage?: typeof persistCataloguePage;
    recordFailure?: typeof recordCatalogueCursorFailure;
  }) {}

  private now() { return (this.deps.now ?? (() => new Date()))().toISOString(); }

  private async assertEnabled(plan: Pick<CataloguePlan,'scope'|'family'|'context'>) {
    if (plan.context.profile.id !== plan.scope.profileId || plan.context.profile.orgId !== plan.scope.orgId || plan.context.job.orgId !== plan.scope.orgId || plan.context.job.profileId !== plan.scope.profileId) throw new PermanentJobError('catalogue profile scope mismatch');
    const enabled=this.deps.isEnabled ?? ((scope,family)=>catalogueSourceEnabled(this.deps.handle,scope,family));
    if (!this.deps.deploymentEnabled() || !await enabled(plan.scope,plan.family)) throw new PermanentJobError(`${plan.family} source is disabled`);
    if (!this.deps.client) throw new PermanentJobError('catalogue Ads client is not configured');
  }

  async plan<K extends CatalogueJob['type']>(context: IngestionContext<K>): Promise<CataloguePlan> {
    const payload=context.payload as CatalogueJob, family=FAMILY_BY_JOB[payload.type];
    const scope={orgId:payload.orgId,profileId:payload.profileId,marketplaceId:payload.marketplaceId};
    const selectorKey=catalogueDigest(payload.type==='ads.change_history.sync' ? {family} : {family,
      ...('asins' in payload ? {asins:[...payload.asins].sort(),adProduct:payload.adProduct} : {}),
      ...('adProducts' in payload ? {adProducts:[...payload.adProducts].sort(),countryCode:payload.countryCode,entityType:payload.entityType} : {})});
    const acquiredAt=this.now();
    const request:CatalogueAcquisitionRequest={id:context.job.id,scope,family,selectorKey,
      requestFingerprint:catalogueDigest({payload,contractVersion:'v1:2026-09-15'}),proposedAcquiredAt:acquiredAt,
      windowStart:payload.type==='ads.change_history.sync'?payload.from:null,
      windowEnd:payload.type==='ads.change_history.sync'?payload.to:null,
      requestedMembers:'asins' in payload?payload.asins.length:'adProducts' in payload?payload.adProducts.length*2:0};
    const plan={context:context as unknown as IngestionContext<CatalogueJob['type']>,scope,family,selectorKey,acquiredAt,request};
    await this.assertEnabled(plan);
    if(payload.type==='ads.change_history.sync') {
      const from=Date.parse(payload.from),to=Date.parse(payload.to),now=Date.parse(acquiredAt);
      if(from>=to || from<now-90*86400_000 || to>now) throw new PermanentJobError('history window is outside provider retention');
    }
    return plan;
  }

  async execute(plan:CataloguePlan):Promise<CatalogueRunResult> {
    const payload=plan.context.payload as CatalogueJob, client=this.deps.client!;
    const resume=this.deps.resume??resumeCatalogueAcquisition, save=this.deps.persistPage??persistCataloguePage;
    try {
      await this.assertEnabled(plan);
      let state:CatalogueAcquisitionState=await resume(this.deps.handle,plan.request);
      let attemptWrittenRows=0;
      while(state.next!==null) {
        await this.assertEnabled(plan);
        const expected=state.next, retrievedAt=this.now(), rows:CatalogueEvidenceRow[]=[];
        let sourceRows=0,refusedRows=0,parsedRows=0,next:CataloguePosition|null=null;
        const advance=(unit:number,token:string|null,total:number):CataloguePosition|null => unit>=total?null:{page:expected.page+1,unit,token};
        if(payload.type==='ads.product_metadata.sync') {
          const batches=batchValues(payload.asins,PRODUCT_METADATA_BATCH_SIZE), batch=batches[expected.unit];
          if(!batch) throw new Error('metadata batch position is invalid');
          const page=await client.getProductMetadataPage(plan.context.profile,{asins:batch,adType:payload.adProduct,cursorToken:expected.token});
          if(page.rows.some(row=>!batch.includes(row.asin))) throw new PermanentJobError('metadata returned an unrequested ASIN');
          sourceRows=page.sourceRows;parsedRows=page.rows.length;
          rows.push(...page.rows.map(row=>metadataSnapshot(plan.scope,payload.adProduct,row,state.acquiredAt,retrievedAt)));
          next=advance(page.nextToken?expected.unit:expected.unit+1,page.nextToken,batches.length);
          if(!page.nextToken) {
            const previous=state.pages.filter(page=>page.expected.unit===expected.unit).flatMap(page=>page.evidence.rows);
            const present=new Set([...previous,...rows].flatMap(row=>'asin' in row?[row.asin]:[]));
            for(const asin of batch) if(!present.has(asin)) {sourceRows++;refusedRows++;rows.push(unavailableMetadata(plan.scope,payload.adProduct,asin,state.acquiredAt,retrievedAt));}
          }
        } else if(payload.type==='ads.product_eligibility.sync') {
          const batches=batchValues(payload.asins,PRODUCT_ELIGIBILITY_BATCH_SIZE),batch=batches[expected.unit];
          if(!batch) throw new Error('eligibility batch position is invalid');
          const page=await client.getProductEligibility(plan.context.profile,{asins:batch,adType:payload.adProduct});
          if(page.rows.some(row=>!batch.includes(row.asin))) throw new PermanentJobError('eligibility returned an unrequested ASIN');
          sourceRows=page.sourceRows+page.missingAsins.length;parsedRows=page.rows.length;refusedRows=page.missingAsins.length;
          rows.push(...page.rows.map(row=>eligibilitySnapshot(plan.scope,payload.adProduct,row,state.acquiredAt,retrievedAt)),...page.missingAsins.map(asin=>unavailableEligibility(plan.scope,payload.adProduct,asin,state.acquiredAt,retrievedAt)));
          next=advance(expected.unit+1,null,batches.length);
        } else if(payload.type==='ads.validation_configurations.sync') {
          const resource=(['campaigns','targeting_clauses'] as const)[expected.unit];
          if(!resource) throw new Error('configuration position is invalid');
          const page=await client.getValidationConfigurations(plan.context.profile,resource,{countryCodes:[payload.countryCode],entityTypes:[payload.entityType],adTypes:payload.adProducts});
          sourceRows=page.sourceRows;parsedRows=page.rows.length;
          for(const row of page.rows) rows.push(ValidationConfiguration.parse({scope:plan.scope,resource,countryCode:row.countryCode,entityType:row.entityType,adProduct:row.adType,providerVersion:null,contentDigest:catalogueDigest(row.configuration),configuration:row.configuration,provenance:provenance('validation_configurations',state.acquiredAt,retrievedAt)}));
          next=advance(expected.unit+1,null,2);
        } else {
          const page=await client.getChangeHistoryPage(plan.context.profile,{from:Date.parse(state.windowStart),to:Date.parse(state.windowEnd),nextToken:expected.token});
          if(page.rows.some(row=>row.timestamp<Date.parse(state.windowStart)||row.timestamp>Date.parse(state.windowEnd))) throw new PermanentJobError('history event is outside the requested window');
          sourceRows=page.sourceRows;parsedRows=page.rows.length;
          rows.push(...page.rows.map(row=>historyEvent(plan.scope,row,retrievedAt)));
          next=page.nextToken?{page:expected.page+1,unit:0,token:page.nextToken}:null;
        }
        const deduped=uniqueRows(rows,catalogueRowIdentity);
        state=await save(this.deps.handle,{acquisition:state,expected,next,rows:deduped.rows,sourceRows,parsedRows,refusedRows,duplicates:deduped.duplicates});
        attemptWrittenRows+=state.attemptWrittenRows;
      }
      if(!state.result) throw new Error('catalogue acquisition has no verified final receipt');
      const counts=state.result.counts;
      return {family:plan.family,observedAt:state.acquiredAt,windowStart:state.windowStart,windowEnd:state.windowEnd,
        requestedMembers:counts.requestedMembers,sourceRows:counts.sourceRows,parsedRows:counts.parsedRows,refusedRows:counts.refusedRows,
        loadedRows:counts.canonicalRows,verifiedLoadedRows:counts.verifiedRows,pages:counts.pages,duplicates:counts.duplicates,
        writtenRows:attemptWrittenRows,existingRows:counts.canonicalRows-attemptWrittenRows,
        coverageGrain:`catalogue:${plan.family}:marketplace:${plan.scope.marketplaceId}:selector:${plan.selectorKey}`};
    } catch(error) {
      await (this.deps.recordFailure??recordCatalogueCursorFailure)(this.deps.handle,plan.scope,plan.family,plan.selectorKey,error instanceof Error?`catalogue source failed (${error.name})`:'catalogue source failed');
      throw error;
    }
  }
}

export function registerCatalogueSources(registry:Pick<IngestionRegistry,'register'>,runner:CatalogueSourceRunner):void{
  for(const type of Object.keys(FAMILY_BY_JOB) as CatalogueJob['type'][]){const family=FAMILY_BY_JOB[type],reportType=REPORT_TYPE_BY_FAMILY[family];registry.register({source:{...ingestionSource(type),jobType:type,reportType},plan:(context)=>runner.plan(context),execute:(plan)=>runner.execute(plan),counts:(result)=>({sourceRows:result.sourceRows,parsedRows:result.parsedRows,refusedRows:result.refusedRows,loadedRows:result.loadedRows,verifiedLoadedRows:result.verifiedLoadedRows}),coverage:{target:(result):CoverageTarget=>({reportType,grain:result.coverageGrain,earliestDate:day(result.windowStart),coveredThrough:day(result.windowEnd),observedAt:result.observedAt,status:result.refusedRows>0?'partial':'complete',settledThrough:null})}});}
}
