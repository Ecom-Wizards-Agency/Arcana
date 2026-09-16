/** Scoped budget snapshots, durable accounting, and existing-period spend evidence. */
import {
  BudgetUsageCampaign, BudgetUsageConfig, BudgetUsageObservation, BudgetUsageRunCounts,
  BudgetUsageRunInput, BudgetUsageScope, BudgetUsageEvidence, BudgetUsagePersistedRun, PortfolioSpendEvidence, ReportCoverageObservation,
  type BudgetUsageCampaignPage, type BudgetUsageIdentity,
} from '@wizard-ads/shared';
import type postgres from 'postgres';
import type { QueryHandle } from '../client.js';
import { readMarketingStreamBudgetUsage } from './dayparting.js';
import { upsertReportCoverage } from './report-coverage.js';

const identity = (row: BudgetUsageIdentity) => `${row.adProduct}|${row.campaignId}`;
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item);
function observationPayload(raw: BudgetUsageObservation) {
  const { receivedAt: _received, ...value } = BudgetUsageObservation.parse(raw);
  return canonical({ ...value, providerUpdatedAt: new Date(value.providerUpdatedAt).toISOString() });
}

async function requireProfile(handle: QueryHandle, raw: BudgetUsageScope) {
  const scope = BudgetUsageScope.parse(raw);
  const rows = await handle.sql`select id from public.ad_profiles where org_id=${scope.orgId} and id=${scope.profileId}`;
  if (rows.length !== 1) throw new Error('Budget usage profile not found in tenant scope');
  return scope;
}

export async function readBudgetUsageConfig(handle: QueryHandle, raw: BudgetUsageScope): Promise<BudgetUsageConfig> {
  const scope = await requireProfile(handle, raw);
  const rows = await handle.sql<{ config: unknown }[]>`select config from public.budget_usage_settings where org_id=${scope.orgId} and profile_id=${scope.profileId}`;
  return BudgetUsageConfig.parse(rows[0]?.config ?? {});
}

export async function readBudgetUsageCampaignPage(handle: QueryHandle, input: BudgetUsageScope & { cursor?: string | null; limit: number }): Promise<BudgetUsageCampaignPage> {
  const scope = await requireProfile(handle, input);
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1000) throw new Error('Budget usage page limit is invalid');
  const rows = await handle.sql<{ campaign_id: string; ad_product: string; campaign_name: string | null; currency: string; budget_type: string; start_date: string | null; end_date: string | null }[]>`
    select c.amazon_id as campaign_id,c.ad_product::text,c.name as campaign_name,p.currency_code as currency,c.budget_type::text,c.start_date::text,c.end_date::text
    from public.campaigns c join public.ad_profiles p on p.org_id=c.org_id and p.id=c.profile_id
    where c.org_id=${scope.orgId} and c.profile_id=${scope.profileId} and c.deleted_at is null and c.state <> 'archived'
      and (${input.cursor ?? null}::text is null or c.amazon_id > ${input.cursor ?? null})
    order by c.amazon_id limit ${input.limit + 1}`;
  const [count] = await handle.sql<{ count: string }[]>`select count(*)::text as count from public.campaigns where org_id=${scope.orgId} and profile_id=${scope.profileId} and deleted_at is null and state <> 'archived'`;
  const campaigns = rows.slice(0, input.limit).map((row) => BudgetUsageCampaign.parse({
    campaignId: row.campaign_id, adProduct: row.ad_product, campaignName: row.campaign_name,
    currency: row.currency, budgetType: row.budget_type === 'daily' || row.budget_type === 'lifetime' ? row.budget_type : null,
    startDate: row.start_date, endDate: row.end_date,
  }));
  return { campaigns, nextCursor: rows.length > input.limit ? campaigns.at(-1)!.campaignId : null, totalCampaigns: Number(count!.count) };
}

/** A failed identity never becomes an observation. A lost output aborts the transaction. */
export async function persistBudgetUsageRun(handle: QueryHandle, raw: BudgetUsageRunInput): Promise<BudgetUsageRunCounts> {
  const input = BudgetUsageRunInput.parse(raw);
  const selected = new Set(input.selected.map(identity));
  const returned = [...input.observations, ...input.failures].map(identity);
  if (selected.size !== input.selected.length || new Set(returned).size !== returned.length || returned.length !== selected.size || returned.some((key) => !selected.has(key))) throw new Error('Budget usage selected identities do not reconcile');
  for (const row of input.observations) {
    if (row.orgId !== input.scope.orgId || row.profileId !== input.scope.profileId || row.source !== input.source) throw new Error('Budget usage observation is outside run scope');
  }
  const write = async (sql: postgres.TransactionSql) => {
    const transaction = { sql };
    await requireProfile(transaction, input.scope);
    await sql`select pg_advisory_xact_lock(hashtextextended(${`budget-usage|${input.scope.orgId}|${input.scope.profileId}|${input.source}`},0))`;
    const config = await readBudgetUsageConfig(transaction, input.scope);
    if (!(input.source === 'amazon_ads_api' ? config.apiEnabled : config.streamEnabled)) throw new Error('Budget usage source is disabled');
    if (selected.size > config.maxCampaigns) throw new Error('Budget usage run exceeds configured campaign bound');
    const priorRun = await readBudgetUsageRun(transaction, { ...input.scope, runId: input.runId });
    if (priorRun) {
      if (canonical(priorRun.input) !== canonical(input)) throw new Error('Conflicting budget usage run identity');
      if (input.observations.length === 0) await markBudgetCoverageUnavailable(sql, priorRun);
      return priorRun.counts;
    }
    const candidates = await sql<{ amazon_id: string; ad_product: string }[]>`select amazon_id,ad_product::text from public.campaigns where org_id=${input.scope.orgId} and profile_id=${input.scope.profileId} and amazon_id=any(${input.selected.map((row) => row.campaignId)}::text[])`;
    const valid = new Set(candidates.map((row) => `${row.ad_product}|${row.amazon_id}`));
    if ([...selected].some((key) => !valid.has(key))) throw new Error('Budget usage selected campaign is outside profile scope');
    let existingRows = 0;
    let streamRows: BudgetUsageObservation[] = [];
    if (input.source === 'amazon_marketing_stream') streamRows = await readMarketingStreamBudgetUsage(transaction, { ...input.scope, fromProviderTime: '1970-01-01T00:00:00.000Z', sourceIdentities: input.observations.map((row) => row.sourceIdentity) });
    for (const observation of input.observations) {
      if (input.source === 'amazon_marketing_stream') {
        if (!streamRows.some((stored) => stored.sourceIdentity === observation.sourceIdentity && observationPayload(stored) === observationPayload(observation))) throw new Error('Budget usage Stream projection verification failed');
        existingRows++;
      } else {
        const rows = await sql<{ observation: BudgetUsageObservation }[]>`select observation from public.budget_usage_observations where org_id=${input.scope.orgId} and profile_id=${input.scope.profileId} and ad_product=${observation.adProduct} and campaign_id=${observation.campaignId} and (source_identity=${observation.sourceIdentity} or provider_updated_at=${observation.providerUpdatedAt}::timestamptz)`;
        if (rows[0]) {
          if (observationPayload(rows[0].observation) !== observationPayload(observation)) throw new Error('Conflicting budget usage observation identity');
          existingRows++;
        }
      }
    }
    const counts = BudgetUsageRunCounts.parse({ selected: selected.size, requested: selected.size, returned: input.observations.length, failed: input.failures.length,
      sourceRows: selected.size, parsedRows: input.observations.length, refusedRows: input.failures.length,
      loadedRows: input.observations.length, existingRows, verifiedLoadedRows: input.observations.length });
    await sql`insert into public.budget_usage_runs(id,org_id,profile_id,source,received_at,input,counts) values (${input.runId},${input.scope.orgId},${input.scope.profileId},${input.source},${input.receivedAt},${JSON.stringify(input)}::jsonb,${JSON.stringify(counts)}::jsonb)`;
    if (input.source === 'amazon_ads_api') for (const row of input.observations) {
      await sql`insert into public.budget_usage_observations(org_id,profile_id,ad_product,campaign_id,source_identity,provider_updated_at,received_at,run_id,observation)
        values (${row.orgId},${row.profileId},${row.adProduct},${row.campaignId},${row.sourceIdentity},${row.providerUpdatedAt},${row.receivedAt},${input.runId},${JSON.stringify(row)}::jsonb) on conflict do nothing`;
    }
    let verified = 0;
    if (input.source === 'amazon_ads_api') for (const row of input.observations) {
      const stored = await sql<{ observation: BudgetUsageObservation }[]>`select observation from public.budget_usage_observations where org_id=${row.orgId} and profile_id=${row.profileId} and ad_product=${row.adProduct} and campaign_id=${row.campaignId} and source_identity=${row.sourceIdentity}`;
      if (stored.length !== 1 || observationPayload(stored[0]!.observation) !== observationPayload(row)) throw new Error('Budget usage persisted output verification failed');
      verified++;
    }
    else verified = input.observations.length;
    const readback = await sql<{ counts: BudgetUsageRunCounts }[]>`select counts from public.budget_usage_runs where org_id=${input.scope.orgId} and profile_id=${input.scope.profileId} and id=${input.runId}`;
    if (verified !== counts.loadedRows || readback.length !== 1 || canonical(readback[0]!.counts) !== canonical(counts)) throw new Error('Budget usage run accounting verification failed');
    if (input.observations.length === 0) await markBudgetCoverageUnavailable(sql, { input, counts });
    return counts;
  };
  return 'savepoint' in handle.sql ? handle.sql.savepoint(write) : handle.sql.begin(write);
}

/** Recover a persisted provider read only after proving its outputs still exist. */
export async function readBudgetUsageRun(handle: QueryHandle, scope: BudgetUsageScope & { runId: string }): Promise<BudgetUsagePersistedRun | null> {
  await requireProfile(handle, scope);
  const rows = await handle.sql<{ input: unknown; counts: unknown }[]>`select input,counts from public.budget_usage_runs where org_id=${scope.orgId} and profile_id=${scope.profileId} and id=${scope.runId}`;
  if (!rows[0]) return null;
  const input = BudgetUsageRunInput.parse(rows[0].input);
  const counts = BudgetUsageRunCounts.parse(rows[0].counts);
  let verified = 0;
  const stream = input.source === 'amazon_marketing_stream' ? await readMarketingStreamBudgetUsage(handle, { ...scope, fromProviderTime: '1970-01-01T00:00:00.000Z', sourceIdentities: input.observations.map((row) => row.sourceIdentity) }) : [];
  for (const observation of input.observations) {
    const stored = input.source === 'amazon_ads_api'
      ? (await handle.sql<{ observation: BudgetUsageObservation }[]>`select observation from public.budget_usage_observations where org_id=${scope.orgId} and profile_id=${scope.profileId} and ad_product=${observation.adProduct} and campaign_id=${observation.campaignId} and source_identity=${observation.sourceIdentity}`).map((row) => row.observation)
      : stream.filter((row) => row.sourceIdentity === observation.sourceIdentity);
    if (stored.length !== 1 || observationPayload(stored[0]!) !== observationPayload(observation)) throw new Error('Budget usage persisted replay verification failed');
    verified++;
  }
  if (verified !== counts.loadedRows) throw new Error('Budget usage replay loaded counts do not reconcile');
  return { input, counts };
}

function coverageForBudgetRun(run: BudgetUsagePersistedRun, timezone: string): ReportCoverageObservation {
  const { input, counts } = run;
  if (input.observations.length === 0) throw new Error('Budget usage coverage requires a provider observation');
  const providerTimes = input.observations.map((row) => new Date(row.providerUpdatedAt).toISOString()).sort();
  const dates = providerTimes.map((at) => new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(at))).sort();
  return ReportCoverageObservation.parse({ ...input.scope, source: input.source, sourceRunId: input.runId,
    reportType: 'campaign_budget_usage', grain: 'campaign_budget_usage',
    observedAt: providerTimes[0], earliestDate: dates[0], coveredThrough: dates.at(-1), settledThrough: null,
    status: !input.populationComplete || input.failures.length > 0 || input.observations.some((row) => row.completeness === 'partial') ? 'partial' : 'complete',
    sourceRows: counts.sourceRows, parsedRows: counts.parsedRows, loadedRows: counts.loadedRows,
    refusedRows: counts.refusedRows, countsMatch: true,
  });
}

/** A failed read invalidates existing completeness without inventing a provider time. */
async function markBudgetCoverageUnavailable(sql: postgres.TransactionSql, run: BudgetUsagePersistedRun): Promise<{ exists: boolean; written: number }> {
  const { input, counts } = run;
  if (input.observations.length !== 0 || counts.loadedRows !== 0 || counts.verifiedLoadedRows !== 0) throw new Error('Budget usage failure coverage requires zero verified observations');
  const [latest] = await sql<{ id: string }[]>`select id from public.budget_usage_runs where org_id=${input.scope.orgId} and profile_id=${input.scope.profileId} and source=${input.source} order by received_at desc,id desc limit 1`;
  if (latest?.id !== input.runId) return { exists: false, written: 0 };
  const before = await sql<{ observed_at: Date | string | null; earliest_date: string | null; covered_through: string | null; settled_through: string | null }[]>`select observed_at,earliest_requested_date::text as earliest_date,latest_loaded_date::text as covered_through,latest_settled_date::text as settled_through from public.report_coverage where org_id=${input.scope.orgId} and profile_id=${input.scope.profileId} and source=${input.source} and report_type='campaign_budget_usage' and grain='campaign_budget_usage' for update`;
  if (before.length === 0) return { exists: false, written: 0 };
  if (before.length !== 1 || before[0]!.observed_at === null) throw new Error('Budget usage failure coverage scope is ambiguous');
  const prior = before[0]!;
  const receipt = await upsertReportCoverage({ sql }, ReportCoverageObservation.parse({
    ...input.scope, source: input.source, sourceRunId: input.runId,
    reportType: 'campaign_budget_usage', grain: 'campaign_budget_usage', status: 'partial',
    observedAt: new Date(prior.observed_at!).toISOString(), earliestDate: prior.earliest_date,
    coveredThrough: prior.covered_through, settledThrough: prior.settled_through,
    sourceRows: counts.sourceRows, parsedRows: counts.parsedRows, loadedRows: 0,
    refusedRows: counts.refusedRows, countsMatch: true,
  }), counts.verifiedLoadedRows, { accounting: 'verified_budget_run' });
  return { exists: true, written: receipt.written };
}

/** Provider time is freshness; the latest verified run owns source accounting. */
export async function publishBudgetUsageCoverage(handle: QueryHandle, raw: ReportCoverageObservation, verifiedLoadedRows: number): Promise<{ offered: number; written: number; unchanged: number }> {
  const requested = ReportCoverageObservation.parse(raw);
  if (requested.reportType !== 'campaign_budget_usage' || requested.grain !== 'campaign_budget_usage'
    || !['amazon_ads_api', 'amazon_marketing_stream'].includes(requested.source) || !requested.sourceRunId) throw new Error('Budget usage coverage requires a scoped source run');
  if (requested.loadedRows !== verifiedLoadedRows) throw new Error('Budget usage coverage verified load does not reconcile');
  const write = async (sql: postgres.TransactionSql) => {
    const transaction = { sql };
    const config = await readBudgetUsageConfig(transaction, requested);
    if (!(requested.source === 'amazon_ads_api' ? config.apiEnabled : config.streamEnabled)) throw new Error('Budget usage coverage source is disabled');
    await sql`select pg_advisory_xact_lock(hashtextextended(${`budget-usage|${requested.orgId}|${requested.profileId}|${requested.source}`},0))`;
    const [profile] = await sql<{ timezone: string }[]>`select timezone from public.ad_profiles where org_id=${requested.orgId} and id=${requested.profileId}`;
    const requestedRun = await readBudgetUsageRun(transaction, { ...requested, runId: requested.sourceRunId! });
    if (!requestedRun || requestedRun.input.source !== requested.source) throw new Error('Budget usage coverage run not found in source scope');
    const expected = coverageForBudgetRun(requestedRun, profile!.timezone);
    if (canonical({ ...requested, observedAt: new Date(requested.observedAt).toISOString() }) !== canonical(expected)) throw new Error('Budget usage coverage differs from its verified source run');
    const [latest] = await sql<{ id: string }[]>`select id from public.budget_usage_runs where org_id=${requested.orgId} and profile_id=${requested.profileId} and source=${requested.source} order by received_at desc,id desc limit 1`;
    const latestRun = latest!.id === requestedRun.input.runId ? requestedRun
      : await readBudgetUsageRun(transaction, { ...requested, runId: latest!.id });
    if (!latestRun) throw new Error('Budget usage latest coverage run disappeared');
    if (latestRun.input.observations.length === 0) {
      const receipt = await markBudgetCoverageUnavailable(sql, latestRun);
      if (!receipt.exists) throw new Error('Budget usage latest run has no provider observation or existing coverage');
      return { offered: 1, written: receipt.written, unchanged: 1 - receipt.written };
    }
    // A delayed older job may finish coverage for the newest verified run, never
    // overwrite its counts. Repeated provider timestamps do not renew freshness.
    const input = coverageForBudgetRun(latestRun, profile!.timezone);
    return upsertReportCoverage(transaction, input, latestRun.counts.verifiedLoadedRows, { accounting: 'verified_budget_run' });
  };
  return 'savepoint' in handle.sql ? handle.sql.savepoint(write) : handle.sql.begin(write);
}

export async function readBudgetUsageEvidence(handle: QueryHandle, scope: BudgetUsageScope): Promise<BudgetUsageEvidence> {
  const config = await readBudgetUsageConfig(handle, scope);
  const campaigns: BudgetUsageCampaign[] = [];
  let totalCampaigns: number;
  let cursor: string | null = null;
  do {
    const page = await readBudgetUsageCampaignPage(handle, { ...scope, cursor, limit: Math.min(config.pageSize, config.maxCampaigns - campaigns.length) });
    campaigns.push(...page.campaigns); cursor = page.nextCursor; totalCampaigns = page.totalCampaigns;
  } while (cursor && campaigns.length < config.maxCampaigns);
  const apiRows = config.apiEnabled ? await handle.sql<{ observation: unknown }[]>`
    select distinct on (ad_product,campaign_id) observation from public.budget_usage_observations
    where org_id=${scope.orgId} and profile_id=${scope.profileId} and campaign_id=any(${campaigns.map((row) => row.campaignId)}::text[])
    order by ad_product,campaign_id,provider_updated_at desc,received_at desc,source_identity desc` : [];
  const streamRows = config.streamEnabled ? await readMarketingStreamBudgetUsage(handle, { ...scope, fromProviderTime: '1970-01-01T00:00:00.000Z' }) : [];
  const rawRuns = await handle.sql<{ source: unknown; input: unknown; counts: unknown }[]>`select distinct on (source) source,input,counts from public.budget_usage_runs where org_id=${scope.orgId} and profile_id=${scope.profileId} order by source,received_at desc,id desc`;
  const runs = rawRuns.map((row) => {
    const run = BudgetUsagePersistedRun.parse(row);
    if (run.input.source !== row.source || run.input.scope.orgId !== scope.orgId || run.input.scope.profileId !== scope.profileId) throw new Error('Budget usage persisted run is outside evidence scope');
    return run;
  });
  const failedApi = new Set(runs.find((row) => row.input.source === 'amazon_ads_api')?.input.failures.map(identity) ?? []);
  return BudgetUsageEvidence.parse({ ...scope, config, campaigns, totalCampaigns, observations: [...apiRows.map((row) => BudgetUsageObservation.parse(row.observation)).filter((row) => !failedApi.has(identity(row))), ...streamRows], sources: (['amazon_ads_api', 'amazon_marketing_stream'] as const).map((source) => {
    const run = runs.find((row) => row.input.source === source);
    return { source, enabled: source === 'amazon_ads_api' ? config.apiEnabled : config.streamEnabled,
      complete: run?.input.populationComplete === true && run.counts.failed === 0 && cursor === null,
      requested: run?.counts.requested ?? 0, failed: run?.counts.failed ?? 0 };
  }) });
}

/** Period evidence remains explicit. Daily usage snapshots do not enter spend aggregation. */
export async function listPortfolioSpendEvidence(handle: QueryHandle, input: BudgetUsageScope & { asOf: string }): Promise<PortfolioSpendEvidence[]> {
  await requireProfile(handle, input);
  const start = `${input.asOf.slice(0,7)}-01`;
  const end = new Date(Date.UTC(Number(input.asOf.slice(0,4)), Number(input.asOf.slice(5,7)), 0)).toISOString().slice(0,10);
  const rows = await handle.sql<{ portfolio_id: string; name: string | null; currency: string; budget_amount: string | null; budget_policy: string | null; member_campaigns: string; expected_days: string; observed_days: string; unassigned: string; spend: string | null; loaded_at: Date | null; membership_complete: boolean }[]>`
    with members as (
      select * from public.campaigns where org_id=${input.orgId} and profile_id=${input.profileId} and deleted_at is null
    ), daily as (
      select ad_product::text as ad_product,campaign_id,date,sum(cost) as spend,min(loaded_at) as loaded_at from public.fact_sp_target_daily
       where org_id=${input.orgId} and profile_id=${input.profileId} and ad_product='SP' and date between ${start}::date and ${input.asOf}::date group by ad_product,campaign_id,date
      union all
      select 'SB',campaign_id,date,sum(cost),min(loaded_at) from public.fact_sb_daily where org_id=${input.orgId} and profile_id=${input.profileId} and date between ${start}::date and ${input.asOf}::date group by campaign_id,date
      union all
      select 'SD',campaign_id,date,sum(cost),min(loaded_at) from public.fact_sd_daily where org_id=${input.orgId} and profile_id=${input.profileId} and date between ${start}::date and ${input.asOf}::date group by campaign_id,date
    ), per_campaign as (
      select m.amazon_id,m.portfolio_amazon_id,m.synced_at,m.first_seen_at,
        greatest(0,least(${input.asOf}::date,coalesce(m.end_date,${input.asOf}::date))-greatest(${start}::date,coalesce(m.start_date,${start}::date))+1) as expected_days,
        count(d.date)::integer as observed_days,sum(d.spend) as spend,min(d.loaded_at) as loaded_at
      from members m left join daily d on d.ad_product=m.ad_product::text and d.campaign_id=m.amazon_id
        and d.date between greatest(${start}::date,coalesce(m.start_date,${start}::date)) and least(${input.asOf}::date,coalesce(m.end_date,${input.asOf}::date))
      group by m.amazon_id,m.portfolio_amazon_id,m.synced_at,m.first_seen_at,m.start_date,m.end_date
    )
    select p.amazon_id as portfolio_id,p.name,a.currency_code as currency,p.budget_amount::text,p.budget_policy,
      count(c.amazon_id)::text as member_campaigns,coalesce(sum(c.expected_days),0)::text as expected_days,
      coalesce(sum(c.observed_days),0)::text as observed_days,sum(c.spend)::text as spend,min(c.loaded_at) as loaded_at,
      (select count(*)::text from members m where m.portfolio_amazon_id is null or not exists (select 1 from public.portfolios x where x.org_id=${input.orgId} and x.profile_id=${input.profileId} and x.amazon_id=m.portfolio_amazon_id and x.deleted_at is null)) as unassigned,
      false as membership_complete
    from public.portfolios p join public.ad_profiles a on a.org_id=p.org_id and a.id=p.profile_id
    left join per_campaign c on c.portfolio_amazon_id=p.amazon_id
    where p.org_id=${input.orgId} and p.profile_id=${input.profileId} and p.deleted_at is null
    group by p.amazon_id,p.name,a.currency_code,p.budget_amount,p.budget_policy,p.synced_at,a.timezone order by p.amazon_id`;
  return rows.map((row) => PortfolioSpendEvidence.parse({ portfolioId: row.portfolio_id, name: row.name, currency: row.currency,
    budgetAmount: row.budget_amount === null ? null : Number(row.budget_amount), budgetPolicy: row.budget_policy,
    period: row.budget_policy === 'monthlyRecurring' ? { start, end } : null, asOf: input.asOf,
    memberCampaigns: Number(row.member_campaigns), expectedCampaignDays: Number(row.expected_days), observedCampaignDays: Number(row.observed_days),
    unassignedCampaigns: Number(row.unassigned), spend: row.spend === null ? null : Number(row.spend), oldestLoadedAt: row.loaded_at === null ? null : new Date(row.loaded_at).toISOString(),
    // The current mirror cannot prove membership throughout a historical period.
    membershipComplete: row.membership_complete,
  }));
}
