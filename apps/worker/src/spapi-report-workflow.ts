import type { SpParsedReport, SpReportCheckpoint, SpReportPlan, SpReportReceipt } from '@wizard-ads/shared';
import { listingChanges } from '@wizard-ads/core';
import { SpApiAmbiguousOutcome, SpApiAuthError, SpApiError, canonicalSpJson, parseAbaSearchTerms, parseCatalogueListings, parseSalesTraffic,
  spReportRequest, SP_REPORT_TYPES, validateSpPlan, type SpApiClient } from '@wizard-ads/sp-api';
import { PermanentJobError } from './permanent-job-error.js';
import { SqpWorkflowPendingError } from './sqp.js';

/** Reuse the worker's existing durable deferral contract without spending retries. */
export class SpReportPendingError extends SqpWorkflowPendingError {
  constructor() {
    super(60);
    this.name = 'SpReportPendingError';
    this.message = 'SP-API report is still processing';
  }
}

export interface SpReportWorkflowDependencies {
  admit(plan:SpReportPlan):Promise<boolean>;
  load(plan:SpReportPlan):Promise<SpReportCheckpoint|null>;
  save(next:SpReportCheckpoint,expected:number|null):Promise<SpReportCheckpoint>;
  promote(report:SpParsedReport):Promise<SpReportReceipt>;
  verify(report:SpParsedReport):Promise<number>;
  previousListing?(plan:SpReportPlan,observedAt:string):Promise<SpParsedReport|null>;
  api(plan:SpReportPlan):Promise<Pick<SpApiClient,'createReport'|'getReport'|'getReportDocument'|'downloadReportDocumentText'>>;
  now?:()=>Date;
}
export async function runSpReportWorkflow(input:SpReportPlan,deps:SpReportWorkflowDependencies):Promise<SpReportReceipt> {
  const plan=validateSpPlan(input);
  const admit=async()=>{if(!await deps.admit(plan))throw new PermanentJobError('SP-API source or exact binding is disabled');};
  await admit();
  let checkpoint=await deps.load(plan);
  if(checkpoint && canonicalSpJson(checkpoint.plan)!==canonicalSpJson(plan))throw new PermanentJobError('SP-API checkpoint differs from admitted request');
  if(checkpoint?.state==='completed'){
    const receipt=checkpoint.receipt;
    if(!receipt || canonicalSpJson(receipt.report.plan)!==canonicalSpJson(plan) || receipt.report.reportId!==checkpoint.reportId
      || receipt.report.documentId!==checkpoint.documentId || receipt.report.observedAt!==checkpoint.observedAt)throw new PermanentJobError('Missing or mismatched completed report receipt');
    const verifiedLoadedRows=await deps.verify(receipt.report);
    return {...receipt,writtenRows:0,verifiedLoadedRows};
  }
  if(checkpoint?.state==='creating')throw new SpApiAmbiguousOutcome('checkpoint');
  const save=async(patch:Partial<SpReportCheckpoint>)=>{
    const expected=checkpoint?.revision??null;
    const next:SpReportCheckpoint={plan,state:'planned',reportId:null,documentId:null,observedAt:null,receipt:null,...checkpoint,...patch,revision:expected===null?0:expected+1};
    const persisted=await deps.save(next,expected);
    if(canonicalSpJson(next)!==canonicalSpJson(persisted))throw new SpApiAmbiguousOutcome('provider-id-persistence');
    checkpoint=persisted;
  };
  const api=await deps.api(plan);
  if(!checkpoint || checkpoint.state==='planned'){
    await save({state:'creating'}); await admit();
    let created:{reportId:string};
    try{ created=await api.createReport(spReportRequest(plan)); }
    catch(error){
      if(error instanceof SpApiAuthError || (error instanceof SpApiError && error.status>=400 && error.status<500 && error.status!==408))await save({state:'planned'});
      throw error;
    }
    if(!created.reportId)throw new SpApiAmbiguousOutcome('response-decoding');
    try{await save({state:'requested',reportId:created.reportId});}catch{throw new SpApiAmbiguousOutcome('provider-id-persistence');}
  }
  // save() has updated the persisted state; reload rather than relying on closure narrowing.
  checkpoint=await deps.load(plan);
  if(!checkpoint?.reportId || checkpoint.state!=='requested')throw new SpApiAmbiguousOutcome('checkpoint');
  await admit();
  const status=await api.getReport(checkpoint.reportId);
  if(status.reportId!==checkpoint.reportId || status.reportType!==SP_REPORT_TYPES[plan.family])throw new PermanentJobError('SP-API returned a mismatched report');
  if(status.processingStatus==='FATAL' || status.processingStatus==='CANCELLED')throw new PermanentJobError('SP-API report has no measured document');
  if(status.processingStatus==='IN_QUEUE' || status.processingStatus==='IN_PROGRESS')throw new SpReportPendingError();
  if(status.processingStatus!=='DONE')throw new PermanentJobError('Unsupported SP-API report status');
  if(!status.reportDocumentId)throw new PermanentJobError('Completed report lacks document identity');
  if(checkpoint.documentId && checkpoint.documentId!==status.reportDocumentId)throw new PermanentJobError('Report document identity changed');
  const now=(deps.now??(()=>new Date()))();
  const providerTime=status.createdTime && Number.isFinite(Date.parse(status.createdTime)) ? new Date(status.createdTime) : null;
  if(providerTime && providerTime>now)throw new PermanentJobError('Report observation is in the future');
  await save({documentId:status.reportDocumentId,observedAt:checkpoint.observedAt??(providerTime??now).toISOString()});
  let text:string|undefined;
  for(let attempt=0;attempt<2;attempt++){
    await admit(); const document=await api.getReportDocument(status.reportDocumentId);
    if(document.reportDocumentId!==status.reportDocumentId)throw new PermanentJobError('Report document mismatch');
    try{await admit();text=await api.downloadReportDocumentText(document);break;}
    catch(error){if(!(error instanceof SpApiError && [401,403,404,410].includes(error.status)))throw error;}
  }
  if(text===undefined)throw new SpApiError('Report download URL expired',403,true,60);
  const context={plan,reportId:status.reportId,documentId:status.reportDocumentId,observedAt:checkpoint!.observedAt!};
  const parsed=plan.family==='retail'?parseSalesTraffic(text,context):plan.family==='aba'?parseAbaSearchTerms(text,context):parseCatalogueListings(text,context);
  if(plan.family==='catalogue'){
    const previous=await deps.previousListing?.(plan,parsed.observedAt)??null;
    parsed.listingPreviousReportId=previous?.reportId??null;
    parsed.listingChanges=listingChanges(previous?[previous,parsed]:[parsed])
      .filter(change=>change.observedAt===parsed.observedAt&&change.id.startsWith(`${parsed.reportId}:`));
  }
  await admit(); const receipt=await deps.promote(parsed);
  if(canonicalSpJson(receipt.report)!==canonicalSpJson(parsed) || receipt.verifiedLoadedRows!==parsed.rows.length)throw new Error('SP-API promotion receipt mismatch');
  await save({state:'completed',receipt});
  return {...receipt,verifiedLoadedRows:await deps.verify(parsed)};
}
