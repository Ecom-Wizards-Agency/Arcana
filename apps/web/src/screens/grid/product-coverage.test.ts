import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@wizard-ads/db/testing';
import { coreReportGrain, promoteCoreReportWindow, readCoreReportEvidence, upsertReportCoverage } from '@wizard-ads/db';
import { CORE_REPORT_FAMILIES, type CoreReportConfiguration, type CoreReportPromotion } from '@wizard-ads/shared';
import { readGridPerformance } from './data-evidence';
import { coreEvidenceGridRows } from './core-report-rows';
let db: TestDatabase;
let orgId: string;
let profileId: string;
let sequence = 0;
const date = '2026-09-01';
beforeAll(async () => { db = await createTestDatabase('wp310_product_coverage'); },120000);
afterAll(async () => { await db?.drop(); });
beforeEach(async () => {
  const [org] = await db.sql`select app.seed_tenant_fixture(${`synthetic-coverage-${randomUUID()}`},${randomUUID()},'owner') as id`;
  orgId = org!['id'] as string;
  const [profile] = await db.sql`select id from public.ad_profiles where org_id=${orgId} limit 1`;
  profileId = profile!['id'] as string;
  await db.sql`select * from app.ensure_fact_partitions(${date}::date,0)`;
});
async function target(spend: number, at = date) {
  await db.sql`insert into public.fact_sp_target_daily(org_id,profile_id,date,ad_product,campaign_id,ad_group_id,target_id,target_kind,cost) values(${orgId},${profileId},${at},'SP','synthetic-c','synthetic-g','synthetic-k','keyword',${spend})`;
}
async function product(cost: number, at = date, family: 'spAdvertisedProduct' | 'sbAdGroup' = 'spAdvertisedProduct', reverse = false) {
  const spec = CORE_REPORT_FAMILIES[family];
  const columns = ['date',...spec.required,...spec.optional,...spec.defaultMetrics];
  const configuration: CoreReportConfiguration = { family,version:1,timeUnit:'DAILY',format:'GZIP_JSON',attributionGeneration:'legacy',columns: reverse ? columns.reverse() : columns };
  const id = randomUUID();
  const observedAt = new Date(Date.parse('2026-09-20T00:00:00.000Z') + ++sequence*1000).toISOString();
  await db.sql`insert into public.report_requests(id,org_id,profile_id,report_type,start_date,end_date,requested_at,family_configuration) values(${id},${orgId},${profileId},${family},${at},${at},${observedAt},${JSON.stringify(configuration)}::jsonb)`;
  const dimensions = { campaignId:'synthetic-c',adGroupId:'synthetic-g',...(family === 'spAdvertisedProduct' ? {advertisedAsin:'B000000001',advertisedSku:null,adId:null} : {}) };
  const p: CoreReportPromotion = { orgId,profileId,reportRequestId:id,requestedAt:observedAt,observedAt,startDate:at,endDate:at,parsed:{configuration,sourceRows:1,parsedRows:1,duplicateRows:0,refusals:[],rows:[{family,periodStart:at,periodEnd:at,timeUnit:'DAILY',attributionGeneration:'legacy',identityResolution:'reported_unresolved',dimensions,metrics:{cost}}]} };
  await db.sql.begin(async (sql) => {
    expect((await promoteCoreReportWindow({sql},p)).loadedRows).toBe(1);
    await upsertReportCoverage({sql},{orgId,profileId,reportType:family,grain:coreReportGrain(configuration),source:'amazon_reporting_v3',status:'complete',earliestDate:at,coveredThrough:at,settledThrough:null,sourceRows:1,parsedRows:1,refusedRows:0,loadedRows:1,countsMatch:true,observedAt},1);
  });
}
it('complete target coverage without product facts leaves Products unmeasured and spend unattributed', async () => {
  await target(10);
  await db.sql`insert into public.report_coverage(org_id,profile_id,report_type,grain,source,status,earliest_returned_date,latest_loaded_date,counts_match) values(${orgId},${profileId},'spTargeting','sp_target','amazon_reporting_v3','complete',${date},${date},true)`;
  const result = await readGridPerformance(db,orgId,profileId,date,date,'products');
  expect(result.feeds.find((feed) => feed.feed==='PPC')).toMatchObject({status:'not-measured',daysHeld:0});
  expect(result.unattributed).toEqual({adGroups:1,spend:10,days:1});
});
it('complete product facts without target coverage measure Products and remove observed spend from the residual', async () => {
  await target(10);
  await product(10);
  expect(await db.sql`select id from public.report_coverage where org_id=${orgId} and profile_id=${profileId} and report_type='spTargeting'`).toHaveLength(0);
  const result = await readGridPerformance(db,orgId,profileId,date,date,'products');
  expect(result.feeds.find((feed) => feed.feed==='PPC')).toMatchObject({status:'complete',daysHeld:1});
  expect(result.unattributed).toBeNull();
});
it('subtracts only observed product spend on verified dates in a partially covered window', async () => {
  await target(10); await target(10,'2026-09-02'); await product(6);
  const result = await readGridPerformance(db,orgId,profileId,date,'2026-09-02','products');
  expect(result.feeds.find((feed) => feed.feed==='PPC')).toMatchObject({status:'partial',daysHeld:1,daysRequested:2});
  expect(result.unattributed).toEqual({adGroups:1,spend:14,days:2});
});
it('equivalent reordered configurations yield one grid row without doubling spend', async () => {
  await product(7,date,'sbAdGroup'); await product(7,date,'sbAdGroup',true);
  const evidence = await readCoreReportEvidence(db,{orgId,profileId,families:['sbAdGroup'],startDate:date,endDate:date});
  const rows = coreEvidenceGridRows(evidence,'USD');
  expect(evidence).toHaveLength(1); expect(rows).toHaveLength(1);
  expect(rows.reduce((sum,row) => sum + row.totals.spend,0)).toBe(7);
});

it('does not hide missing SD product coverage behind a complete SP report', async () => {
  await product(10);
  await db.sql`insert into public.product_ads(org_id,profile_id,amazon_id,ad_product,campaign_id,ad_group_id,asin,state) values(${orgId},${profileId},'synthetic-sd-ad','SD','synthetic-sd-c','synthetic-sd-g','B000000002','enabled')`;
  const result = await readGridPerformance(db,orgId,profileId,date,date,'products');
  expect(result.feeds.find((feed) => feed.feed==='PPC')).toMatchObject({status:'partial',daysHeld:0,daysRequested:1});
});
