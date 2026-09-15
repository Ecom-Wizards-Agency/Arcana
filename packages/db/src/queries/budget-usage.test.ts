import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { BudgetUsageConfig, type BudgetUsageObservation, type BudgetUsageRunInput, type BudgetUsageRunCounts, type ReportCoverageObservation } from '@wizard-ads/shared';
import { createTestDatabase, type TestDatabase } from '../testing/harness.js';
import { asUser } from '../testing/rls.js';
import { listPortfolioSpendEvidence, persistBudgetUsageRun, publishBudgetUsageCoverage, readBudgetUsageCampaignPage, readBudgetUsageConfig, readBudgetUsageEvidence, readBudgetUsageRun } from './budget-usage.js';
import { readMarketingStreamBudgetUsage } from './dayparting.js';

let database: TestDatabase;
const owner = randomUUID();
const orgId = randomUUID();
const otherOrg = randomUUID();
const profileId = randomUUID();
const secondProfile = randomUUID();
const otherProfile = randomUUID();
const scope = { orgId, profileId };
const at = '2026-09-02T12:00:00.000Z';
beforeAll(async () => {
  database = await createTestDatabase('budget_usage');
  await database.sql`insert into auth.users(id) values(${owner})`;
  await database.sql`insert into public.orgs(id,slug,name) values(${orgId},'synthetic-budget-a','Synthetic budget A'),(${otherOrg},'synthetic-budget-b','Synthetic budget B')`;
  await database.sql`insert into public.org_members(org_id,user_id,role) values(${orgId},${owner},'owner')`;
  for (const [org, profile] of [[orgId,profileId],[orgId,secondProfile],[otherOrg,otherProfile]]) {
    await database.sql`insert into public.ad_profiles(id,org_id,amazon_profile_id,region,country_code,currency_code,timezone) values(${profile!},${org!},${profile!},'NA','US','USD','UTC')`;
    await database.sql`insert into public.campaigns(org_id,profile_id,amazon_id,ad_product,state,budget_amount,budget_type) values(${org!},${profile!},'same-campaign','SP','enabled',40,'daily')`;
  }
}, 60_000);
afterAll(async () => { await database?.drop(); });

const observation = (usagePercent = 0, providerUpdatedAt = at): BudgetUsageObservation => ({ ...scope, adProduct: 'SP', campaignId: 'same-campaign', source: 'amazon_ads_api', sourceIdentity: `api|SP|same-campaign|${providerUpdatedAt}`, currency: 'USD', budgetAmount: 40, budgetType: 'daily', period: { start: '2026-09-02', end: '2026-09-02' }, usagePercent, providerUpdatedAt, receivedAt: at, completeness: 'complete' });
const run = (row = observation()): BudgetUsageRunInput => ({ scope, runId: randomUUID(), source: 'amazon_ads_api', selected: [{ adProduct: row.adProduct, campaignId: row.campaignId }], observations: [row], failures: [], receivedAt: row.receivedAt, populationComplete: true });

it('defaults both sources off and refuses disabled persistence', async () => {
  expect(await readBudgetUsageConfig(database, scope)).toEqual(BudgetUsageConfig.parse({}));
  expect(await readMarketingStreamBudgetUsage(database, { ...scope, fromProviderTime: at })).toEqual([]);
  await expect(persistBudgetUsageRun(database, run())).rejects.toThrow('disabled');
  await database.sql`insert into public.budget_usage_settings(org_id,profile_id,config) values(${orgId},${profileId},${JSON.stringify(BudgetUsageConfig.parse({ apiEnabled: true }))}::jsonb)`;
});

it('loads zero, replays without replacing receipt time, and rejects conflicting identity', async () => {
  const first = run();
  expect(await persistBudgetUsageRun(database, first)).toMatchObject({ selected: 1, returned: 1, loadedRows: 1, existingRows: 0, verifiedLoadedRows: 1 });
  expect(await persistBudgetUsageRun(database, first)).toMatchObject({ existingRows: 0 });
  const replay = run({ ...observation(), receivedAt: '2026-09-03T12:00:00.000Z' });
  expect(await persistBudgetUsageRun(database, replay)).toMatchObject({ existingRows: 1, loadedRows: 1 });
  const evidence = await readBudgetUsageEvidence(database, scope);
  expect(evidence.observations).toHaveLength(1);
  expect(evidence.observations[0]).toMatchObject({ usagePercent: 0, receivedAt: at, providerUpdatedAt: at });
  await expect(persistBudgetUsageRun(database, run(observation(12)))).rejects.toThrow('Conflicting');
  await expect(persistBudgetUsageRun(database, run({ ...observation(), sourceIdentity: 'different-identity-same-provider-time' }))).rejects.toThrow('Conflicting');
});

it('keeps newer provider evidence over late arrivals and preserves over-budget usage', async () => {
  await persistBudgetUsageRun(database, run(observation(125, '2026-09-04T12:00:00.000Z')));
  await persistBudgetUsageRun(database, run({ ...observation(30, '2026-09-01T12:00:00.000Z'), receivedAt: '2026-09-08T12:00:00.000Z' }));
  expect((await readBudgetUsageEvidence(database, scope)).observations[0]).toMatchObject({ usagePercent: 125, providerUpdatedAt: '2026-09-04T12:00:00.000Z' });
  await database.sql`update public.budget_usage_settings set config=jsonb_set(config,'{apiEnabled}','false') where profile_id=${profileId}`;
  expect((await readBudgetUsageEvidence(database, scope)).observations).toEqual([]);
  await database.sql`update public.budget_usage_settings set config=jsonb_set(config,'{apiEnabled}','true') where profile_id=${profileId}`;
});

it('accounts for failures without inventing usage and rejects missing or repeated identities', async () => {
  const failed = { ...run(), observations: [], failures: [{ adProduct: 'SP' as const, campaignId: 'same-campaign', code: 'UNAVAILABLE', details: null }], receivedAt: '2026-09-09T12:00:00.000Z' };
  expect(await persistBudgetUsageRun(database, failed)).toMatchObject({ selected: 1, failed: 1, returned: 0, parsedRows: 0, refusedRows: 1, loadedRows: 0 });
  expect((await readBudgetUsageEvidence(database, scope)).sources[0]).toMatchObject({ complete: false, failed: 1 });
  expect((await readBudgetUsageEvidence(database, scope)).observations).toEqual([]);
  await expect(persistBudgetUsageRun(database, { ...run(), observations: [] })).rejects.toThrow('identities');
  await expect(persistBudgetUsageRun(database, { ...run(), selected: [run().selected[0]!, run().selected[0]!] })).rejects.toThrow('identities');
});

it('rejects cross-tenant/profile reads and rows with identical campaign identifiers', async () => {
  await expect(readBudgetUsageConfig(database, { orgId, profileId: otherProfile })).rejects.toThrow('scope');
  await expect(asUser(database, owner, (sql) => readBudgetUsageEvidence({ sql }, { orgId: otherOrg, profileId: otherProfile }))).rejects.toThrow();
  expect((await readBudgetUsageEvidence(database, { orgId, profileId: secondProfile })).observations).toEqual([]);
  await expect(persistBudgetUsageRun(database, run({ ...observation(), profileId: secondProfile }))).rejects.toThrow('scope');
  await expect(database.sql`insert into public.budget_usage_settings(org_id,profile_id) values(${orgId},${otherProfile})`).rejects.toThrow();
});

it('paginates exact selected identities and reports the complete population', async () => {
  for (const [id,product] of [['page-b','SB'],['page-c','SD']]) await database.sql`insert into public.campaigns(org_id,profile_id,amazon_id,ad_product,state,budget_amount,budget_type) values(${orgId},${profileId},${id!},${product!},'enabled',10,'daily')`;
  const first = await readBudgetUsageCampaignPage(database, { ...scope, limit: 2 });
  const second = await readBudgetUsageCampaignPage(database, { ...scope, limit: 2, cursor: first.nextCursor });
  expect(first.totalCampaigns).toBe(3);
  expect(new Set([...first.campaigns,...second.campaigns].map((row) => row.campaignId)).size).toBe(3);
  expect(second.nextCursor).toBeNull();
});

it('refuses a dropped output before writing a successful run, and rechecks saved output on replay', async () => {
  await database.sql`create function app.synthetic_drop_budget_row() returns trigger language plpgsql as $$ begin if new.source_identity like 'drop-%' then return null; end if; return new; end $$`;
  await database.sql`create trigger synthetic_drop_budget_row before insert on public.budget_usage_observations for each row execute function app.synthetic_drop_budget_row()`;
  const dropped = run({ ...observation(0,'2026-09-05T12:00:00.000Z'), sourceIdentity: 'drop-output' });
  await expect(persistBudgetUsageRun(database, dropped)).rejects.toThrow('verification');
  expect(await readBudgetUsageRun(database, { ...scope, runId: dropped.runId })).toBeNull();
  await database.sql`drop trigger synthetic_drop_budget_row on public.budget_usage_observations`;
  const saved = run({ ...observation(0,'2026-09-06T12:00:00.000Z'), sourceIdentity: 'replay-output' });
  await persistBudgetUsageRun(database, saved);
  await database.sql`delete from public.budget_usage_observations where org_id=${orgId} and profile_id=${profileId} and source_identity='replay-output'`;
  await expect(readBudgetUsageRun(database, { ...scope, runId: saved.runId })).rejects.toThrow('verification');
  await expect(persistBudgetUsageRun(database, saved)).rejects.toThrow('verification');
});

it('uses separate portfolio member spend, preserves missing days, and exposes unsupported periods', async () => {
  await database.sql`insert into public.portfolios(org_id,profile_id,amazon_id,ad_product,state,budget_amount,budget_policy) values(${orgId},${profileId},'portfolio-a','SP','enabled',800,'monthlyRecurring'),(${orgId},${profileId},'portfolio-b','SP','enabled',300,'dateRange')`;
  await database.sql`update public.campaigns set portfolio_amazon_id='portfolio-a' where profile_id=${profileId} and amazon_id='same-campaign'`;
  await database.sql`update public.campaigns set portfolio_amazon_id='portfolio-b',budget_amount=100 where profile_id=${profileId} and amazon_id='page-b'`;
  await database.sql`insert into public.fact_sp_target_daily(org_id,profile_id,date,ad_product,campaign_id,ad_group_id,target_id,target_kind,cost) values(${orgId},${profileId},'2026-09-01','SP','same-campaign','group','target','keyword',11)`;
  await database.sql`insert into public.fact_sb_daily(org_id,profile_id,date,campaign_id,ad_group_id,cost) values(${orgId},${profileId},'2026-09-01','page-b','group',31)`;
  const rows = await listPortfolioSpendEvidence(database, { ...scope, asOf: '2026-09-02' });
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ portfolioId: 'portfolio-a', memberCampaigns: 1, expectedCampaignDays: 2, observedCampaignDays: 1, unassignedCampaigns: 1, spend: 11, period: { start: '2026-09-01', end: '2026-09-30' }, membershipComplete: false });
  expect(rows[1]).toMatchObject({ portfolioId: 'portfolio-b', memberCampaigns: 1, spend: 31, period: null });
  expect(rows.reduce((total,row) => total + row.memberCampaigns, 0) + rows[0]!.unassignedCampaigns).toBe(3);
});

it('enforces immutable rows and rejects incomplete JSON scope records directly in SQL', async () => {
  await expect(database.sql`update public.budget_usage_observations set received_at=now() where org_id=${orgId} and profile_id=${profileId}`).rejects.toThrow('immutable');
  await expect(database.sql`insert into public.budget_usage_runs(id,org_id,profile_id,source,received_at,input,counts) values(${randomUUID()},${orgId},${profileId},'amazon_ads_api',now(),'{}','{}')`).rejects.toThrow();
});

it('keeps API snapshots out of Stream and requires active binding, current revision, verified projection and no block', async () => {
  expect(await database.sql`select id from public.marketing_stream_hourly_facts where org_id=${orgId} and profile_id=${profileId}`).toHaveLength(0);
  const binding = randomUUID();
  const firstEvent = randomUUID();
  const secondEvent = randomUUID();
  await database.sql`insert into public.marketing_stream_subscription_bindings(id,org_id,profile_id,subscription_id,provider_dataset_id,advertiser_id,marketplace_id) values(${binding},${orgId},${profileId},'synthetic-budget-subscription','budget-usage','synthetic-advertiser','synthetic-marketplace')`;
  const insertEvent = async (id: string, revision: number, usage: number, received: string) => {
    await database.sql`insert into public.marketing_stream_events(id,org_id,profile_id,message_id,dataset,ad_product,event_time,received_at,revision,payload_hash,raw_payload,binding_id,provider_subscription_id,provider_dataset_id,provider_event_id,provider_advertiser_id,provider_marketplace_id)
      values(${id},${orgId},${profileId},'synthetic-logical-message','budget_usage','SP',${at},${received},${revision},${`hash-${revision}`},${JSON.stringify({ currencyCode: 'USD', metrics: [{ campaignId: 'same-campaign', budgetUsagePercent: usage, budgetObservedAt: at }] })}::jsonb,${binding},'synthetic-budget-subscription','budget-usage',${`provider-${revision}`},'synthetic-advertiser','synthetic-marketplace')`;
  };
  await insertEvent(firstEvent,0,60,at);
  const read = () => readMarketingStreamBudgetUsage(database, { ...scope, fromProviderTime: '1970-01-01T00:00:00.000Z' });
  expect(await read()).toEqual([]);
  await database.sql`update public.budget_usage_settings set config=jsonb_set(config,'{streamEnabled}','true') where profile_id=${profileId}`;
  expect(await read()).toEqual([]);
  await database.sql`insert into public.marketing_stream_hourly_facts(org_id,profile_id,ad_product,campaign_id,utc_hour,profile_timezone,local_date,local_hour,local_day_of_week,currency_code,budget_usage_percent,settling_state,source_events,loaded_at)
    values(${orgId},${profileId},'SP','same-campaign',${at},'UTC','2026-09-02',12,3,'USD',60,'settled',1,'2026-09-02T12:01:00Z')`;
  expect(await read()).toMatchObject([{ campaignId: 'same-campaign', usagePercent: 60, source: 'amazon_marketing_stream', budgetAmount: null, sourceIdentity: `${firstEvent}:same-campaign` }]);
  await insertEvent(secondEvent,1,85,'2026-09-02T12:02:00Z');
  expect(await read()).toEqual([]);
  await database.sql`update public.marketing_stream_hourly_facts set budget_usage_percent=85,loaded_at='2026-09-02T12:03:00Z' where profile_id=${profileId}`;
  expect(await read()).toMatchObject([{ usagePercent: 85, sourceIdentity: `${secondEvent}:same-campaign` }]);
  await expect(insertEvent(randomUUID(),1,85,'2026-09-02T12:02:00Z')).rejects.toThrow();
  await database.sql`update public.marketing_stream_subscription_bindings set active=false where id=${binding}`;
  expect(await read()).toEqual([]);
  await database.sql`update public.marketing_stream_subscription_bindings set active=true where id=${binding}`;
  await database.sql`insert into public.marketing_stream_projection_blocks(org_id,profile_id,first_blocked_at,last_blocked_at,last_reason) values(${orgId},${profileId},${at},${at},'Synthetic policy block')`;
  expect(await read()).toEqual([]);
  await database.sql`delete from public.marketing_stream_projection_blocks where profile_id=${profileId}`;
  const streamObservations = await read();
  expect(await persistBudgetUsageRun(database, { ...run(), source: 'amazon_marketing_stream', observations: streamObservations })).toMatchObject({ loadedRows: 1, verifiedLoadedRows: 1, existingRows: 1 });
  expect(await database.sql`select id from public.marketing_stream_hourly_facts where org_id=${orgId} and profile_id=${profileId}`).toHaveLength(1);
});

it('replays saved Stream identities after a newer independent observation, but refuses invalidated evidence', async () => {
  const [binding] = await database.sql<{ id: string }[]>`select id from public.marketing_stream_subscription_bindings where org_id=${orgId} and profile_id=${profileId} and subscription_id='synthetic-budget-subscription'`;
  const oldEvent = randomUUID();
  const newerEvent = randomUUID();
  const oldTime = '2026-09-03T12:00:00.000Z';
  const newerTime = '2026-09-03T13:00:00.000Z';
  const insert = async (id: string, message: string, time: string, usage: number, revision = 0) => {
    await database.sql`insert into public.marketing_stream_events(id,org_id,profile_id,message_id,dataset,ad_product,event_time,received_at,revision,payload_hash,raw_payload,binding_id,provider_subscription_id,provider_dataset_id,provider_event_id,provider_advertiser_id,provider_marketplace_id)
      values(${id},${orgId},${profileId},${message},'budget_usage','SP',${time},${time},${revision},${id},${JSON.stringify({ metrics: [{ campaignId: 'same-campaign', budgetUsagePercent: usage, budgetObservedAt: time }] })}::jsonb,${binding!.id},'synthetic-budget-subscription','budget-usage',${id},'synthetic-advertiser','synthetic-marketplace')`;
    await database.sql`insert into public.marketing_stream_hourly_facts(org_id,profile_id,ad_product,campaign_id,utc_hour,profile_timezone,local_date,local_hour,local_day_of_week,currency_code,budget_usage_percent,settling_state,source_events,loaded_at)
      values(${orgId},${profileId},'SP','same-campaign',${time},'UTC','2026-09-03',${new Date(time).getUTCHours()},4,'USD',${usage},'settled',1,${time})
      on conflict (profile_id,ad_product,campaign_id,utc_hour) do update set budget_usage_percent=excluded.budget_usage_percent,loaded_at=excluded.loaded_at`;
  };
  await insert(oldEvent,oldEvent,oldTime,70);
  const observations = await readMarketingStreamBudgetUsage(database, { ...scope, fromProviderTime: oldTime });
  expect(observations).toHaveLength(1);
  const saved = { ...run(), source: 'amazon_marketing_stream' as const, observations, receivedAt: oldTime };
  const counts = await persistBudgetUsageRun(database, saved);
  await insert(newerEvent,newerEvent,newerTime,90);
  expect(await readMarketingStreamBudgetUsage(database, { ...scope, fromProviderTime: oldTime })).toMatchObject([{ sourceIdentity: `${newerEvent}:same-campaign` }]);
  expect(await readBudgetUsageRun(database, { ...scope, runId: saved.runId })).toEqual({ input: saved, counts });
  expect(await persistBudgetUsageRun(database, saved)).toEqual(counts);
  expect(await database.sql`select id from public.budget_usage_runs where id=${saved.runId}`).toHaveLength(1);
  await database.sql`update public.marketing_stream_subscription_bindings set active=false where id=${binding!.id}`;
  await expect(readBudgetUsageRun(database, { ...scope, runId: saved.runId })).rejects.toThrow('verification');
  await database.sql`update public.marketing_stream_subscription_bindings set active=true where id=${binding!.id}`;
  await database.sql`insert into public.marketing_stream_projection_blocks(org_id,profile_id,first_blocked_at,last_blocked_at,last_reason) values(${orgId},${profileId},${oldTime},${oldTime},'Synthetic replay block')`;
  await expect(readBudgetUsageRun(database, { ...scope, runId: saved.runId })).rejects.toThrow('verification');
  await database.sql`delete from public.marketing_stream_projection_blocks where profile_id=${profileId}`;
  await insert(randomUUID(),oldEvent,oldTime,75,1);
  await expect(readBudgetUsageRun(database, { ...scope, runId: saved.runId })).rejects.toThrow('verification');
  await expect(persistBudgetUsageRun(database, saved)).rejects.toThrow('verification');
});

it.each(['input', 'counts', 'timestamp'])('rejects malformed persisted %s at the Home evidence boundary', async (malformed) => {
  const input = { ...run(), observations: [], selected: [], receivedAt: '2026-10-01T12:00:00.000Z' };
  const counts = { selected: 0, requested: 0, returned: 0, failed: 0, sourceRows: 0, parsedRows: 0, refusedRows: 0, loadedRows: 0, existingRows: 0, verifiedLoadedRows: 0 };
  const rawInput = malformed === 'input' ? { ...input, populationComplete: 'false' }
    : malformed === 'timestamp' ? { ...input, receivedAt: 'invalid-time' } : input;
  const rawCounts = malformed === 'counts' ? { ...counts, requested: '0' } : counts;
  await database.sql`insert into public.budget_usage_runs(id,org_id,profile_id,source,received_at,input,counts)
    values(${input.runId},${orgId},${profileId},'amazon_ads_api',${input.receivedAt},${JSON.stringify(rawInput)}::jsonb,${JSON.stringify(rawCounts)}::jsonb)`;
  try {
    await expect(readBudgetUsageEvidence(database, scope)).rejects.toThrow();
  } finally {
    await database.sql`delete from public.budget_usage_runs where id=${input.runId}`;
  }
});

function coverage(run: BudgetUsageRunInput, counts: BudgetUsageRunCounts): ReportCoverageObservation {
  const providerTimes = run.observations.map((row) => row.providerUpdatedAt).sort();
  return { ...run.scope, source: run.source, sourceRunId: run.runId, reportType: 'campaign_budget_usage', grain: 'campaign_budget_usage',
    observedAt: providerTimes[0]!, earliestDate: providerTimes[0]!.slice(0,10), coveredThrough: providerTimes.at(-1)!.slice(0,10), settledThrough: null,
    status: run.failures.length > 0 ? 'partial' : 'complete', sourceRows: counts.sourceRows, parsedRows: counts.parsedRows,
    loadedRows: counts.loadedRows, refusedRows: counts.refusedRows, countsMatch: true };
}

it('publishes complete then partial counts at unchanged provider time and never lets an older retry restore old counts', async () => {
  const providerAt = '2026-09-10T12:00:00.000Z';
  const first = { ...observation(45,providerAt), period: { start: '2026-09-10', end: '2026-09-10' } };
  const second = { ...first, adProduct: 'SB' as const, campaignId: 'page-b', sourceIdentity: 'coverage-second-campaign' };
  const complete = { ...run(first), selected: [{ adProduct: 'SP' as const, campaignId: 'same-campaign' }, { adProduct: 'SB' as const, campaignId: 'page-b' }], observations: [first,second], receivedAt: '2026-09-15T12:00:00.000Z' };
  const completeCounts = await persistBudgetUsageRun(database, complete);
  expect(await publishBudgetUsageCoverage(database, coverage(complete,completeCounts), 2)).toEqual({ offered: 1, written: 1, unchanged: 0 });
  const partial = { ...complete, runId: randomUUID(), receivedAt: '2026-09-15T13:00:00.000Z', observations: [first], failures: [{ adProduct: 'SB' as const, campaignId: 'page-b', code: 'UNAVAILABLE', details: null }] };
  const partialCounts = await persistBudgetUsageRun(database, partial);
  expect(await publishBudgetUsageCoverage(database, coverage(partial,partialCounts), 1)).toEqual({ offered: 1, written: 1, unchanged: 0 });
  const read = () => database.sql<{ status: string; source_rows: string; parsed_rows: string; loaded_rows: string; refused_rows: string; observed_at: string | Date }[]>`select status,source_rows::text,parsed_rows::text,loaded_rows::text,refused_rows::text,observed_at from public.report_coverage where org_id=${orgId} and profile_id=${profileId} and report_type='campaign_budget_usage' and source='amazon_ads_api'`;
  expect((await read())[0]).toMatchObject({ status: 'partial', source_rows: '2', parsed_rows: '1', loaded_rows: '1', refused_rows: '1' });
  expect(new Date((await read())[0]!.observed_at).toISOString()).toBe(providerAt);
  expect(await publishBudgetUsageCoverage(database, coverage(complete,completeCounts), 2)).toEqual({ offered: 1, written: 0, unchanged: 1 });
  // If the new run has not published yet, the old retry publishes its verified
  // replacement instead of claiming an unchanged row that does not exist.
  await database.sql`delete from public.report_coverage where org_id=${orgId} and profile_id=${profileId} and report_type='campaign_budget_usage' and source='amazon_ads_api'`;
  expect(await publishBudgetUsageCoverage(database, coverage(complete,completeCounts), 2)).toEqual({ offered: 1, written: 1, unchanged: 0 });
  expect((await read())[0]).toMatchObject({ status: 'partial', loaded_rows: '1', refused_rows: '1' });
  expect(new Date((await read())[0]!.observed_at).toISOString()).toBe(providerAt);
  await expect(publishBudgetUsageCoverage(database, { ...coverage(partial,partialCounts), observedAt: '2026-09-15T13:00:00.000Z' }, 1)).rejects.toThrow('differs');
  await expect(publishBudgetUsageCoverage(database, { ...coverage(partial,partialCounts), profileId: secondProfile }, 1)).rejects.toThrow();
  await database.sql`delete from public.budget_usage_observations where org_id=${orgId} and profile_id=${profileId} and campaign_id='same-campaign' and provider_updated_at=${providerAt}`;
  await expect(publishBudgetUsageCoverage(database, coverage(partial,partialCounts), 1)).rejects.toThrow('verification');
});

it('marks existing coverage partial on total failure without renewing provider time or inventing initial coverage', async () => {
  const providerAt = '2026-09-11T12:00:00.000Z';
  const complete = { ...run(observation(50,providerAt)), receivedAt: '2026-09-16T12:00:00.000Z' };
  const completeCounts = await persistBudgetUsageRun(database, complete);
  await publishBudgetUsageCoverage(database, coverage(complete,completeCounts), 1);
  const failed = { ...complete, runId: randomUUID(), observations: [], failures: [{ adProduct: 'SP' as const, campaignId: 'same-campaign', code: 'UNAVAILABLE', details: null }], receivedAt: '2026-09-17T12:00:00.000Z' };
  expect(await persistBudgetUsageRun(database, failed)).toMatchObject({ selected: 1, failed: 1, loadedRows: 0, verifiedLoadedRows: 0 });
  const read = () => database.sql<{ status: string; loaded_rows: string; refused_rows: string; observed_at: Date | string; covered_through: string }[]>`select status,loaded_rows::text,refused_rows::text,observed_at,latest_loaded_date::text as covered_through from public.report_coverage where org_id=${orgId} and profile_id=${profileId} and source='amazon_ads_api' and report_type='campaign_budget_usage'`;
  expect((await read())[0]).toMatchObject({ status: 'partial', loaded_rows: '0', refused_rows: '1', covered_through: '2026-09-11' });
  expect(new Date((await read())[0]!.observed_at).toISOString()).toBe(providerAt);
  expect(await publishBudgetUsageCoverage(database, coverage(complete,completeCounts), 1)).toEqual({ offered: 1, written: 0, unchanged: 1 });
  const newerComplete = { ...complete, runId: randomUUID(), receivedAt: '2026-09-18T12:00:00.000Z' };
  const newerCounts = await persistBudgetUsageRun(database, newerComplete);
  await publishBudgetUsageCoverage(database, coverage(newerComplete,newerCounts), 1);
  await persistBudgetUsageRun(database, { ...failed, runId: randomUUID(), receivedAt: '2026-09-16T13:00:00.000Z' });
  expect((await read())[0]).toMatchObject({ status: 'complete', loaded_rows: '1', refused_rows: '0' });
  await database.sql`insert into public.budget_usage_settings(org_id,profile_id,config) values(${orgId},${secondProfile},'{"apiEnabled":true}')`;
  const neverMeasured = { ...failed, runId: randomUUID(), scope: { orgId, profileId: secondProfile } };
  expect(await persistBudgetUsageRun(database, neverMeasured)).toMatchObject({ loadedRows: 0, failed: 1 });
  expect(await database.sql`select id from public.report_coverage where org_id=${orgId} and profile_id=${secondProfile} and report_type='campaign_budget_usage'`).toHaveLength(0);
});
