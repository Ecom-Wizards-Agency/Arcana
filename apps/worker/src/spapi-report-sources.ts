import { admitSpReportPlan, getSpApiRefreshToken, loadSpReportCheckpoint, promoteSpReport, previousSpListingReport, saveSpReportCheckpoint, verifySpReport, type DbHandle } from '@wizard-ads/db';
import type { SpReportPlan, SpReportReceipt } from '@wizard-ads/shared';
import { LwaRefreshTokenProvider, SpApiClient, SP_REPORT_TYPES, type FetchLike } from '@wizard-ads/sp-api';
import { ingestionSource } from './ingestion-sources.js';
import type { IngestionRegistry } from './ingestion-registry.js';
import { PermanentJobError } from './permanent-job-error.js';
import { runSpReportWorkflow, type SpReportWorkflowDependencies } from './spapi-report-workflow.js';
import { spApiEndpointForRegion } from './spapi-sqp.js';
import { MinimumIntervalSqpProviderGate } from './sqp.js';

export function registerSpApiReportSources(registry:Pick<IngestionRegistry,'register'>,deps:SpReportWorkflowDependencies):void{
  for(const family of ['retail','aba','catalogue'] as const){
    const type=`${family}.report.request` as const;
    registry.register({source:{...ingestionSource(type),jobType:type,reportType:SP_REPORT_TYPES[family]},
      plan(context){
        const plan=context.payload.plan;
        if(plan.family!==family || plan.scope.orgId!==context.job.orgId || plan.scope.profileId!==context.job.profileId
          || context.payload.orgId!==plan.scope.orgId || context.payload.profileId!==plan.scope.profileId
          || context.profile.id!==plan.scope.profileId || context.profile.orgId!==plan.scope.orgId || context.profile.region!==plan.scope.region)throw new PermanentJobError('SP-API queued scope mismatch');
        return plan;
      },
      execute:async(plan)=>({receipt:await runSpReportWorkflow(plan,deps)}),
      counts:({receipt})=>({sourceRows:receipt.report.counts.sourceRows,parsedRows:receipt.report.counts.parsedRows,
        refusedRows:receipt.report.counts.refusedRows,loadedRows:receipt.report.rows.length,verifiedLoadedRows:receipt.verifiedLoadedRows}),
      coverage:{target:({receipt}:{receipt:SpReportReceipt})=>({reportType:SP_REPORT_TYPES[family],grain:family,
        earliestDate:receipt.report.plan.start,coveredThrough:receipt.report.plan.end,settledThrough:null,
        observedAt:receipt.report.observedAt,status:receipt.report.complete?'complete':'partial'})},
    });
  }
}
export function postgresSpReportDependencies(options:{handle:DbHandle;clientId:string;clientSecret:string;fetch?:FetchLike;now?:()=>Date}):SpReportWorkflowDependencies{
  const { clientSecret: lwaKey } = options;
  const gate=new MinimumIntervalSqpProviderGate(100_000);
  const clients=new Map<string,SpApiClient>();
  return {
    admit:plan=>admitSpReportPlan(options.handle,plan),load:plan=>loadSpReportCheckpoint(options.handle,plan),
    save:(next,expected)=>saveSpReportCheckpoint(options.handle,next,expected),promote:report=>promoteSpReport(options.handle,report),
    previousListing:(plan,observedAt)=>previousSpListingReport(options.handle,plan,observedAt),
    verify:report=>verifySpReport(options.handle,report),...(options.now?{now:options.now}:{}),
    async api(plan:SpReportPlan){
      const key=JSON.stringify([plan.scope.orgId,plan.scope.connectionId,plan.scope.region]);
      let client=clients.get(key);
      if(!client){client=new SpApiClient({endpoint:spApiEndpointForRegion(plan.scope.region),userAgent:'Arcana/1.0',
        accessTokenProvider:new LwaRefreshTokenProvider({clientId:options.clientId,clientSecret:lwaKey,
          refreshTokenProvider:()=>getSpApiRefreshToken(options.handle,{orgId:plan.scope.orgId,connectionId:plan.scope.connectionId}),
          ...(options.fetch?{fetch:options.fetch}:{})}),...(options.fetch?{fetch:options.fetch}:{})});clients.set(key,client);}
      const api=client;
      return {createReport:async(request)=>{await gate.beforeCall('create_report', key);if(!await admitSpReportPlan(options.handle,plan))throw new PermanentJobError('SP-API binding revoked before create');return api.createReport(request);},
        getReport:api.getReport.bind(api),getReportDocument:api.getReportDocument.bind(api),downloadReportDocumentText:api.downloadReportDocumentText.bind(api)};
    },
  };
}
