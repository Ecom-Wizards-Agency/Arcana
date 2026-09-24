import { createHash } from 'node:crypto';
import { type SpReportAdmission, sameSpReportDocument, SP_REPORT_FRESHNESS_HOURS, FreshnessCoverage, SpReportCheckpoint, SpParsedReport, SpReportScope, SpRetailSpendEvidence, type SpReportPlan, type SpReportFamily, type SpReportReceipt, type SpEvidence } from '@wizard-ads/shared';
import type { DbHandle, QueryHandle } from '../client.js';

const tables = { retail: 'fact_retail_sales_traffic_daily', aba: 'fact_aba_search_terms_periodic', catalogue: 'spapi_listing_observations' } as const;

/** Seller-wide spend requires every bound profile and all three Ads products, including evidenced empty reports. */
export async function readSpRetailSpendEvidence(handle:QueryHandle,input:{orgId:string;profileId:string;start:string;end:string}):Promise<SpRetailSpendEvidence|null>{
  const scope=await resolveSpReportScope(handle,{...input,family:'retail'});if(!scope)return null;
  const profiles=await handle.sql`select distinct p.id,p.currency_code,p.sync_enabled,b.enabled,c.status::text,
    c.vault_secret_id is not null as has_credential,p.region=app.spapi_region_for_marketplace(b.marketplace_id) as region_matches,
    b.marketplace_id=any(c.marketplace_ids) as marketplace_matches
    from public.spapi_profile_bindings b join public.spapi_connections c on c.org_id=b.org_id and c.id=b.connection_id
    join public.ad_profiles p on p.org_id=b.org_id and p.id=b.profile_id
    where b.org_id=${scope.orgId} and c.selling_partner_id=${scope.sellingPartnerId} and b.marketplace_id=${scope.marketplaceId}`;
  const currencies=new Set(profiles.map(p=>String(p['currency_code'])));
  if(!profiles.length||currencies.size!==1||profiles.some(p=>!p['sync_enabled']||!p['enabled']||p['status']!=='active'
    ||!p['has_credential']||!p['region_matches']||!p['marketplace_matches']))return null;
  const days=Math.round((Date.parse(input.end)-Date.parse(input.start))/86400000)+1;
  if(!Number.isFinite(days)||days<1||days>366)return null;
  const ledger=await handle.sql`select *,start_date::text as start_date,end_date::text as end_date from public.report_requests where org_id=${scope.orgId} and profile_id=any(${profiles.map(p=>String(p['id']))}::uuid[])
    and report_type::text in ('spCampaigns','sbCampaigns','sdCampaigns') and start_date<=${input.end} and end_date>=${input.start} order by requested_at desc,id`;
  const totals=new Map<string,number>();
  const verified=new Map<string,Map<string,number>>();
  for(let day=0;day<days;day++){
    const date=new Date(Date.parse(input.start)+day*86400000).toISOString().slice(0,10);let spend=0;
    for(const profile of profiles)for(const [type,table] of [['spCampaigns','fact_profile_daily'],['sbCampaigns','fact_sb_daily'],['sdCampaigns','fact_sd_daily']] as const){
      const report=ledger.find(r=>r['profile_id']===profile['id']&&r['report_type']===type&&String(r['start_date']).slice(0,10)<=date&&String(r['end_date']).slice(0,10)>=date);
      if(!report||report['status']!=='completed'||report['rows_loaded']===null||report['completed_at']===null||Number(report['refused_rows'])!==0||report['refused_rows']===null)return null;
      const id=String(report['id']);let values=verified.get(id);
      if(!values){
        const facts=await handle.sql.unsafe<{date:string;cost:string;currency_code:string|null}[]>(`select date::text,cost::text,${type==='spCampaigns'?'currency_code':'null::text'} as currency_code from public.${table} where org_id=$1 and profile_id=$2 and report_request_id=$3`,[scope.orgId,String(profile['id']),id]);
        if(facts.length!==Number(report['rows_loaded']))return null;
        if(facts.some(f=>f.currency_code!==null&&f.currency_code!==[...currencies][0]))return null;
        values=new Map();for(const fact of facts){const cost=Number(fact.cost);if(!Number.isFinite(cost)||cost<0)return null;values.set(fact.date,(values.get(fact.date)??0)+cost);}verified.set(id,values);
      }
      // A completed verified empty report is an observed zero for its declared date window.
      spend+=values.get(date)??0;
    }
    totals.set(date,spend);
  }
  return SpRetailSpendEvidence.parse({...input,...scope,currency:[...currencies][0],complete:true,scope:'seller',rows:[...totals].map(([date,spend])=>({date,spend}))});
}
export async function previousSpListingReport(handle:QueryHandle,plan:SpReportPlan,observedAt:string):Promise<SpParsedReport|null>{
  const s=plan.scope;
  const rows=await handle.sql`select report from public.spapi_report_receipts where org_id=${s.orgId} and selling_partner_id=${s.sellingPartnerId}
    and marketplace_id=${s.marketplaceId} and family='catalogue' and observed_at<${observedAt}::timestamptz order by observed_at desc,request_id limit 1`;
  return rows[0]?SpParsedReport.parse(rows[0]['report']):null;
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
/** Binding and source enablement are independent, exact and rechecked on every attempt. */
export async function resolveSpReportScope(handle: QueryHandle, input: { orgId: string; profileId: string; family: SpReportFamily }): Promise<SpReportScope | null> {
  const rows = await handle.sql`
    select b.org_id, b.profile_id, b.connection_id, b.marketplace_id, c.selling_partner_id, p.region::text
    from public.spapi_profile_bindings b
    join public.spapi_connections c on c.org_id=b.org_id and c.id=b.connection_id
    join public.ad_profiles p on p.org_id=b.org_id and p.id=b.profile_id
    join public.spapi_report_sources s on s.org_id=b.org_id and s.profile_id=b.profile_id and s.connection_id=b.connection_id
    where b.org_id=${input.orgId} and b.profile_id=${input.profileId} and s.family=${input.family}
      and s.enabled and b.enabled and p.sync_enabled and c.status='active' and c.vault_secret_id is not null
      and nullif(btrim(c.selling_partner_id),'') is not null and b.marketplace_id=any(c.marketplace_ids)
      and p.region=app.spapi_region_for_marketplace(b.marketplace_id)`;
  const r = rows[0];
  return r ? SpReportScope.parse({ orgId:r['org_id'],profileId:r['profile_id'],connectionId:r['connection_id'],marketplaceId:r['marketplace_id'],sellingPartnerId:r['selling_partner_id'],region:r['region'] }) : null;
}
export async function admitSpReportPlan(handle: QueryHandle, plan: SpReportPlan): Promise<SpReportAdmission> {
  const s=plan.scope;
  const [row]=await handle.sql`select p.sync_enabled,p.region::text,b.enabled as binding_enabled,b.connection_id,b.marketplace_id,
    c.selling_partner_id,c.status::text,c.vault_secret_id is not null as has_credential,
    b.marketplace_id=any(c.marketplace_ids) as marketplace_matches,
    p.region=app.spapi_region_for_marketplace(b.marketplace_id) as region_matches,
    src.enabled as source_enabled,src.connection_id as source_connection_id
    from public.ad_profiles p left join public.spapi_profile_bindings b on b.org_id=p.org_id and b.profile_id=p.id
    left join public.spapi_connections c on c.org_id=b.org_id and c.id=b.connection_id
    left join public.spapi_report_sources src on src.org_id=p.org_id and src.profile_id=p.id and src.family=${plan.family}
    where p.org_id=${s.orgId} and p.id=${s.profileId}`;
  const refuse=(code: Extract<SpReportAdmission,{admitted:false}>['code']):SpReportAdmission=>({admitted:false,code});
  if(!row)return refuse('profile_unavailable');
  if(!row['source_enabled'])return refuse('source_disabled');
  if(!row['binding_enabled'])return refuse('binding_disabled');
  if(!row['sync_enabled'])return refuse('profile_sync_disabled');
  if(row['connection_id']!==s.connectionId || row['source_connection_id']!==s.connectionId)return refuse('connection_mismatch');
  if(row['selling_partner_id']!==s.sellingPartnerId || !s.sellingPartnerId.trim())return refuse('seller_mismatch');
  if(row['marketplace_id']!==s.marketplaceId || !row['marketplace_matches'])return refuse('marketplace_mismatch');
  if(row['region']!==s.region || !row['region_matches'])return refuse('region_mismatch');
  if(row['status']!=='active'||!row['has_credential'])return refuse('credential_unavailable');
  return {admitted:true,scope:s};
}
export async function loadSpReportCheckpoint(handle: QueryHandle, plan: SpReportPlan): Promise<SpReportCheckpoint | null> {
  const rows = await handle.sql`select checkpoint from public.spapi_report_runs where org_id=${plan.scope.orgId} and profile_id=${plan.scope.profileId} and family=${plan.family} and request_id=${plan.requestId}`;
  if (!rows[0]) return null;
  const checkpoint = SpReportCheckpoint.parse(rows[0]['checkpoint']);
  if (stable(checkpoint.plan) !== stable(plan)) throw new Error('SP-API checkpoint scope conflict');
  return checkpoint;
}
export async function saveSpReportCheckpoint(handle: QueryHandle, next: SpReportCheckpoint, expectedRevision: number | null): Promise<SpReportCheckpoint> {
  const c = SpReportCheckpoint.parse(next), p = c.plan;
  if (c.revision !== (expectedRevision === null ? 0 : expectedRevision + 1)) throw new Error('Checkpoint revision conflict');
  const rows = await handle.sql`
    insert into public.spapi_report_runs(org_id,profile_id,family,request_id,revision,checkpoint)
    values (${p.scope.orgId},${p.scope.profileId},${p.family},${p.requestId},${c.revision},${JSON.stringify(c)}::jsonb)
    on conflict (org_id,profile_id,family,request_id) do update set revision=excluded.revision,checkpoint=excluded.checkpoint
    where spapi_report_runs.revision=${expectedRevision} and spapi_report_runs.checkpoint->'plan'=excluded.checkpoint->'plan'
    returning checkpoint`;
  if (rows.length !== 1) throw new Error('Checkpoint compare-and-swap failed');
  const observed = await loadSpReportCheckpoint(handle,p);
  if (stable(observed) !== stable(c)) throw new Error('Checkpoint readback conflict');
  return c;
}
/** Verify exact persisted identities and values, including completed-checkpoint replay. */
export async function verifySpReport(handle: QueryHandle, raw: SpParsedReport): Promise<number> {
  const report = SpParsedReport.parse(raw), {scope,family,requestId} = report.plan;
  if(family!=='catalogue'){
    const newer=await handle.sql`select 1 from public.spapi_report_receipts where org_id=${scope.orgId} and selling_partner_id=${scope.sellingPartnerId}
      and marketplace_id=${scope.marketplaceId} and family=${family} and start_date=${report.plan.start} and end_date=${report.plan.end}
      and observed_at>${report.observedAt}::timestamptz limit 1`;
    if(newer.length)throw new Error('SP-API receipt has been superseded');
  }
  const rows = await handle.sql.unsafe<{payload: unknown}[]>(
    `select payload from public.${tables[family]} where org_id=$1 and selling_partner_id=$2 and marketplace_id=$3 and date between $4 and $5`
    + (family === 'catalogue' ? ' and profile_id=$6 and report_request_id=$7' : report.complete ? '' : ' and row_key=any($6::text[])'),
    family === 'catalogue' ? [scope.orgId,scope.sellingPartnerId,scope.marketplaceId,report.plan.start,report.plan.end,scope.profileId,requestId]
      : report.complete ? [scope.orgId,scope.sellingPartnerId,scope.marketplaceId,report.plan.start,report.plan.end]
        : [scope.orgId,scope.sellingPartnerId,scope.marketplaceId,report.plan.start,report.plan.end,report.rows.map(r=>r.key)]);
  const expected = new Map(report.rows.map(row=>[row.key,stable(row)]));
  if (rows.length !== expected.size || rows.some(row => {
    const value = row.payload as {key?:string}; return expected.get(value.key ?? '') !== stable(row.payload);
  })) throw new Error('SP-API destination readback mismatch');
  return rows.length;
}
export async function promoteSpReport(handle: Pick<DbHandle,'sql'>, raw: SpParsedReport): Promise<SpReportReceipt> {
  const report=SpParsedReport.parse(raw), {scope,family,requestId,start,end}=report.plan;
  return handle.sql.begin(async sql => {
    if (!(await admitSpReportPlan({sql},report.plan)).admitted) throw new Error('SP-API source no longer admitted');
    await sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([scope.orgId,scope.sellingPartnerId,scope.marketplaceId,family,start,end])},0))`;
    await sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify([scope.orgId,scope.sellingPartnerId,scope.marketplaceId,family,report.reportId,report.documentId])},0))`;
    const documents=await sql`select report from public.spapi_report_receipts where org_id=${scope.orgId}
      and selling_partner_id=${scope.sellingPartnerId} and marketplace_id=${scope.marketplaceId} and family=${family}
      and report->>'reportId'=${report.reportId} and report->>'documentId'=${report.documentId}
      order by observed_at,request_id limit 1`;
    if(documents[0]){
      const original=SpParsedReport.parse(documents[0]['report']);
      if(!sameSpReportDocument(original,report))throw new Error('Provider document identity conflict');
      return {report:original,writtenRows:0,verifiedLoadedRows:await verifySpReport({sql},original)};
    }
    if(family!=='catalogue')await sql`select app.ensure_fact_partitions(${start}::date,0)`;
    const existing=await sql`select report from public.spapi_report_receipts where org_id=${scope.orgId} and profile_id=${scope.profileId} and family=${family} and request_id=${requestId}`;
    if (existing.length) {
      if(stable(existing[0]!['report'])!==stable(report)) throw new Error('Immutable report receipt conflict');
      return {report,writtenRows:0,verifiedLoadedRows:await verifySpReport({sql},report)};
    }
    if(family==='catalogue' && report.listingPreviousReportId!==undefined){
      const prior=await previousSpListingReport({sql},report.plan,report.observedAt);
      if((prior?.reportId??null)!==report.listingPreviousReportId)throw new Error('Listing adjacency changed before promotion');
    }
    const newer=await sql`select 1 from public.spapi_report_receipts where org_id=${scope.orgId} and selling_partner_id=${scope.sellingPartnerId}
      and marketplace_id=${scope.marketplaceId} and family=${family} and start_date=${start} and end_date=${end}
      and observed_at>${report.observedAt}::timestamptz limit 1`;
    if (newer.length && family!=='catalogue') throw new Error('Superseded SP-API observation');
    if(family!=='catalogue'){
      const tied=await sql`select report from public.spapi_report_receipts where org_id=${scope.orgId} and selling_partner_id=${scope.sellingPartnerId}
        and marketplace_id=${scope.marketplaceId} and family=${family} and start_date=${start} and end_date=${end} and observed_at=${report.observedAt}::timestamptz`;
      if(tied.some(r=>{const prior=SpParsedReport.parse(r['report']);return prior.payloadFingerprint!==report.payloadFingerprint || prior.complete!==report.complete;}))throw new Error('Conflicting equal-time SP-API observations');
    }
    if (family !== 'catalogue' && report.complete) {
      await sql.unsafe(`delete from public.${tables[family]} where org_id=$1 and selling_partner_id=$2 and marketplace_id=$3 and date between $4 and $5`,[scope.orgId,scope.sellingPartnerId,scope.marketplaceId,start,end]);
    }
    let writtenRows=0;
    for(const row of report.rows) {
      if (row.date < start || row.date > end) throw new Error('Report row outside period');
      const grain=row.kind==='retail'?row.grain:row.kind==='aba'?(row.slot===0?'query':'slot'):'listing';
      const result=await sql.unsafe(`insert into public.${tables[family]} (org_id,selling_partner_id,marketplace_id,date,row_key,profile_id,connection_id,grain,observed_at,report_request_id,payload)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`+
        (family==='catalogue'?' on conflict do nothing':' on conflict (org_id,selling_partner_id,marketplace_id,date,row_key) do update set payload=excluded.payload,observed_at=excluded.observed_at,report_request_id=excluded.report_request_id,profile_id=excluded.profile_id,connection_id=excluded.connection_id where '+tables[family]+'.observed_at<=excluded.observed_at')+' returning row_key',
        [scope.orgId,scope.sellingPartnerId,scope.marketplaceId,row.date,row.key,scope.profileId,scope.connectionId,grain,report.observedAt,requestId,JSON.stringify(row)]);
      writtenRows+=result.length;
    }
    const verifiedLoadedRows=await verifySpReport({sql},report);
    if(writtenRows!==report.rows.length) throw new Error('SP-API promotion write count mismatch');
    const receipts=await sql`insert into public.spapi_report_receipts(org_id,profile_id,family,request_id,selling_partner_id,marketplace_id,start_date,end_date,observed_at,report)
      values (${scope.orgId},${scope.profileId},${family},${requestId},${scope.sellingPartnerId},${scope.marketplaceId},${start},${end},${report.observedAt},${JSON.stringify(report)}::jsonb) returning report`;
    if(receipts.length!==1 || stable(receipts[0]!['report'])!==stable(report)) throw new Error('Report receipt readback mismatch');
    return {report,writtenRows,verifiedLoadedRows};
  });
}
export async function readSpListingHistory(handle: QueryHandle,input:{orgId:string;profileId:string;start:string;end:string}):Promise<SpParsedReport[]> {
  const scope=await resolveSpReportScope(handle,{...input,family:'catalogue'});
  if(!scope) return [];
  const rows=await handle.sql`select report from public.spapi_report_receipts where org_id=${scope.orgId} and selling_partner_id=${scope.sellingPartnerId}
    and marketplace_id=${scope.marketplaceId} and family='catalogue' and start_date between ${input.start} and ${input.end} order by observed_at,request_id`;
  return rows.map(row=>SpParsedReport.parse(row['report']));
}
export async function listSpReportPeriods(handle: QueryHandle,input:{orgId:string;profileId:string;family:SpReportFamily}):Promise<{marketplaceId:string;start:string;end:string;observedAt:string;rows:number}[]> {
  const scope=await resolveSpReportScope(handle,input);
  if(!scope)return [];
  const rows=await handle.sql`select distinct on (start_date,end_date) start_date::text,end_date::text,observed_at,report from public.spapi_report_receipts
    where org_id=${scope.orgId} and selling_partner_id=${scope.sellingPartnerId} and marketplace_id=${scope.marketplaceId} and family=${input.family}
    order by start_date desc,end_date desc,observed_at desc`;
  return rows.map(r=>({marketplaceId:scope.marketplaceId,start:String(r['start_date']),end:String(r['end_date']),observedAt:new Date(r['observed_at']).toISOString(),rows:SpParsedReport.parse(r['report']).rows.length}));
}
const reportTypes = { retail: 'GET_SALES_AND_TRAFFIC_REPORT', aba: 'GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT', catalogue: 'GET_MERCHANT_LISTINGS_ALL_DATA' } as const;
/** Read the producer's exact period observation; a receipt alone cannot publish freshness. */
async function publishedSpReportState(handle:QueryHandle,report:SpParsedReport,now:Date):Promise<SpEvidence['state']>{
  const {scope,family,start,end}=report.plan;
  const rows=await handle.sql`select status::text,source,report_type,latest_loaded_date::text,observed_at,
    source_rows,parsed_rows,loaded_rows,refused_rows,counts_match
    from public.report_coverage where org_id=${scope.orgId} and profile_id=${scope.profileId}
      and source='amazon_spapi' and report_type=${reportTypes[family]}
      and grain in (${family},${`${family}:${start}:${end}`})
      and earliest_returned_date=${start} and latest_loaded_date=${end} order by observed_at desc limit 1`;
  const row=rows[0];if(!row || row['observed_at']===null)return 'unavailable';
  const number=(key:string)=>row[key]===null?null:Number(row[key]);
  const observation=FreshnessCoverage.safeParse({source:row['source'],reportType:row['report_type'],status:row['status'],
    coveredThrough:row['latest_loaded_date'],observedAt:new Date(row['observed_at']).toISOString(),sourceRows:number('source_rows'),
    parsedRows:number('parsed_rows'),loadedRows:number('loaded_rows'),refusedRows:number('refused_rows'),countsMatch:row['counts_match']});
  if(!observation.success)return 'unavailable';
  const c=observation.data;
  if(!['complete','partial'].includes(c.status) || c.countsMatch!==true || c.observedAt!==report.observedAt
    || c.sourceRows!==report.counts.sourceRows || c.parsedRows!==report.counts.parsedRows
    || c.refusedRows!==report.counts.refusedRows || c.loadedRows!==report.counts.canonicalRows)return 'unavailable';
  if(now.getTime()-Date.parse(c.observedAt)>SP_REPORT_FRESHNESS_HOURS[family]*3_600_000)return 'stale';
  return c.status==='partial'||!report.complete?'partial':'measured';
}
export async function readSpReportEvidence(handle: QueryHandle,input:{orgId:string;profileId:string;family:SpReportFamily;start:string;end:string;now?:Date;latest?:boolean}):Promise<SpEvidence> {
  const unavailable=(reason:string):SpEvidence=>({state:'unavailable',reason,report:null});
  const scope=await resolveSpReportScope(handle,input);
  if(!scope) return unavailable('Source disabled or exact seller binding unavailable');
  if(input.latest){
    const periods=await listSpReportPeriods(handle,input);
    const latest=periods.sort((a,b)=>b.observedAt.localeCompare(a.observedAt))[0];
    if(!latest)return unavailable('No source observation');
    return readSpReportEvidence(handle,{...input,latest:false,start:latest.start,end:latest.end});
  }
  const rows=await handle.sql`select report from public.spapi_report_receipts where org_id=${scope.orgId} and selling_partner_id=${scope.sellingPartnerId}
    and marketplace_id=${scope.marketplaceId} and family=${input.family} and start_date>=${input.start} and end_date<=${input.end} order by observed_at desc,request_id`;
  const reports=rows.map(r=>SpParsedReport.parse(r['report']));
  if(!reports.length) return unavailable('No report observed for this period');
  let report=reports[0]!;
  let selectedReports=[report];
  if(input.family==='retail') {
    const days=new Map<string,SpParsedReport>();
    for(const r of reports) if(!days.has(r.plan.start)) days.set(r.plan.start,r);
    const expected=Math.round((Date.parse(input.end)-Date.parse(input.start))/86400000)+1;
    if(days.size!==expected) return unavailable('Retail date coverage has gaps');
    const selected=[...days.values()]; selectedReports=selected;
    for(const r of selected) { try { await verifySpReport(handle,r); } catch { return unavailable('Retail destination verification failed'); } }
    const canonical=selected.flatMap(r=>r.rows);
    const count=(key:'sourceRows'|'parsedRows'|'refusedRows'|'duplicateRows'|'addedRows'|'canonicalRows')=>selected.reduce((n,r)=>n+r.counts[key],0);
    report=SpParsedReport.parse({...report,plan:{...report.plan,start:input.start,end:input.end},rows:canonical,
      observedAt:selected.map(r=>r.observedAt).sort()[0],complete:selected.every(r=>r.complete),
      payloadFingerprint:createHash('sha256').update(selected.map(r=>r.payloadFingerprint).sort().join('')).digest('hex'),
      counts:{sourceRows:count('sourceRows'),parsedRows:count('parsedRows'),refusedRows:count('refusedRows'),duplicateRows:count('duplicateRows'),addedRows:count('addedRows'),canonicalRows:count('canonicalRows')}});
  } else {
    if(input.family==='aba') {
      const exact=reports.find(r=>r.plan.start===input.start && r.plan.end===input.end);
      if(!exact) return unavailable('ABA requires an exact covered provider week'); report=exact; selectedReports=[report];
    }
    try{await verifySpReport(handle,report);}catch{return unavailable('Destination verification failed');}
  }
  const states=await Promise.all(selectedReports.map(r=>publishedSpReportState(handle,r,input.now??new Date())));
  if(states.includes('unavailable'))return unavailable('No matching successful, counted coverage publication for this period');
  const state=states.includes('stale')?'stale':states.includes('partial')?'partial':'measured';
  return {state,reason:state==='stale'?'Published source observation is stale':state==='partial'?'Published coverage contains incomplete evidence':null,report};
}
