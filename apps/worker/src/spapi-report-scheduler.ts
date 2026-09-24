import { resolveSpReportScope, type DbHandle } from '@wizard-ads/db';
import { SpReportFamily, type SpReportPlan } from '@wizard-ads/shared';
import { SP_REPORT_CONTRACT, spFingerprint } from '@wizard-ads/sp-api';
import { SP_API_REPORT_CADENCES } from './schedules.js';

/** A persisted opt-in scope is required. Credentials and consent never provision a source. */
export async function provisionSpApiReportJobs(handle:Pick<DbHandle,'sql'>,now=new Date()):Promise<{offered:number;enqueued:number;duplicates:number;disabledScopes:number}>{
  const counts={offered:0,enqueued:0,duplicates:0,disabledScopes:0};
  const [relation]=await handle.sql`select to_regclass('public.spapi_report_sources')::text as relation`;
  if(!relation?.['relation'])return counts;
  await handle.sql.begin(async sql=>{
    const scopes=await sql`select s.*,p.timezone from public.spapi_report_sources s join public.ad_profiles p on p.org_id=s.org_id and p.id=s.profile_id
      where s.enabled and s.schedule_enabled and s.policy_accepted and s.next_run_at<=${now.toISOString()}::timestamptz
      order by s.org_id,s.profile_id,s.family for update of s skip locked`;
    for(const source of scopes){
      const family=SpReportFamily.parse(source['family']);
      const orgId=String(source['org_id']),profileId=String(source['profile_id']);
      const scope=await resolveSpReportScope({sql},{orgId,profileId,family});
      if(!scope){
        const changed=await sql`update public.spapi_report_sources set schedule_enabled=false where org_id=${orgId} and profile_id=${profileId} and family=${family} returning profile_id`;
        if(changed.length!==1)throw new Error('Source disablement count mismatch'); counts.disabledScopes++;continue;
      }
      const today=family==='retail'
        ? new Intl.DateTimeFormat('en-CA',{timeZone:String(source['timezone']),year:'numeric',month:'2-digit',day:'2-digit'}).format(now)
        : now.toISOString().slice(0,10);
      const day=(offset:number)=>new Date(Date.parse(`${today}T00:00:00Z`)+offset*86400000).toISOString().slice(0,10);
      const windows:{start:string;end:string}[]=[];
      if(family==='aba'){
        const weekday=new Date(`${today}T00:00:00Z`).getUTCDay();
        windows.push({start:day(-weekday-7),end:day(-weekday-1)});
      }else if(family==='retail'){
        for(let back=1;back<=1+Number(source['restatement_days']);back++)windows.push({start:day(-back),end:day(-back)});
      }else {
        // Inventory is an observation, not historical date-filtered data. Use
        // the provider timestamp's UTC calendar; stale queued snapshots refuse.
        const observedDay=now.toISOString().slice(0,10);
        windows.push({start:observedDay,end:observedDay});
      }
      for(const window of windows){
        const requestId=spFingerprint([scope,family,window,today]);
        const plan:SpReportPlan={scope,family,requestId,...window,requestedAt:now.toISOString(),contractVersion:SP_REPORT_CONTRACT};
        const payload={type:`${family}.report.request`,orgId,profileId,plan};
        counts.offered++;
        const jobs=await sql`insert into public.sync_jobs(org_id,profile_id,job_type,payload,dedupe_key)
          values (${orgId},${profileId},${payload.type}::public.sync_job_type,${JSON.stringify(payload)}::jsonb,${'spapi-report:'+requestId})
          on conflict (org_id,dedupe_key) where dedupe_key is not null do nothing returning id`;
        if(jobs.length>1)throw new Error('Report schedule fan-out mismatch');
        counts.enqueued+=jobs.length;counts.duplicates+=1-jobs.length;
      }
      const changed=await sql`update public.spapi_report_sources set next_run_at=${now.toISOString()}::timestamptz+${SP_API_REPORT_CADENCES[family].cadence}::interval
        where org_id=${orgId} and profile_id=${profileId} and family=${family} returning profile_id`;
      if(changed.length!==1)throw new Error('Report schedule update count mismatch');
    }
  });
  if(counts.offered!==counts.enqueued+counts.duplicates)throw new Error('Report schedule counts do not reconcile');
  return counts;
}
