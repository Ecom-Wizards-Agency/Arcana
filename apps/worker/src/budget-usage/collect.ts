import { createHash } from 'node:crypto';
import { AdsApiHttpError, AdsApiTimeoutError } from '@wizard-ads/ads-api';
import {
  BudgetUsageObservation, BudgetUsageResult, BudgetUsageRunCounts, BudgetUsageConfig, BudgetUsageCampaignPage, BudgetUsagePersistedRun,
  type AdProduct, type BudgetUsageCampaign, type BudgetUsageScope,
  type BudgetUsageFailure, type BudgetUsageSource,
  type BudgetUsageRunInput,
} from '@wizard-ads/shared';
import type { AdsProfileContext } from '../ads-api.js';
import { PermanentJobError } from '../permanent-job-error.js';
import type { BudgetUsageProvider } from './provider.js';

export interface BudgetUsageCollectorStore {
  config(scope: BudgetUsageScope): Promise<BudgetUsageConfig>;
  replay(scope: BudgetUsageScope, runId: string): Promise<BudgetUsagePersistedRun | null>;
  campaigns(scope: BudgetUsageScope, limit: number, cursor: string | null): Promise<BudgetUsageCampaignPage>;
  stream(scope: BudgetUsageScope): Promise<BudgetUsageObservation[]>;
  persist(input: BudgetUsageRunInput): Promise<BudgetUsageRunCounts>;
}
export interface BudgetUsageCollectorInput {
  scope: BudgetUsageScope; profile: AdsProfileContext; runId: string; source: BudgetUsageSource;
  enabled: boolean; store: BudgetUsageCollectorStore; provider: BudgetUsageProvider; now?: () => Date;
}

/** One selection is reconciled by full product/campaign identity before persistence. */
export async function collectBudgetUsage(input: BudgetUsageCollectorInput) {
  if (!input.enabled) throw new PermanentJobError('Budget usage source is disabled');
  const { scope, store, source } = input;
  if (input.profile.id !== scope.profileId || input.profile.orgId !== scope.orgId) throw new PermanentJobError('Budget usage profile scope mismatch');
  const config = BudgetUsageConfig.parse(await store.config(scope));
  if (!(source === 'amazon_ads_api' ? config.apiEnabled : config.streamEnabled)) throw new PermanentJobError('Budget usage profile source is disabled');
  const saved = await store.replay(scope, input.runId);
  if (saved) {
    const replay = BudgetUsagePersistedRun.parse(saved);
    if (replay.input.scope.orgId !== scope.orgId || replay.input.scope.profileId !== scope.profileId
      || replay.input.runId !== input.runId || replay.input.source !== source) throw new Error('Budget usage replay scope mismatch');
    return resultForRun(replay.input, replay.counts, input.profile.timezone);
  }
  const clock = input.now ?? (() => new Date());
  const observations: BudgetUsageObservation[] = [];
  const failures: (BudgetUsageFailure & { adProduct: AdProduct })[] = [];
  const selected: BudgetUsageCampaign[] = [];
  let total: number | null = null;
  let cursor: string | null = null;
  const cursors = new Set<string>();
  do {
    const limit = Math.min(config.pageSize, config.maxCampaigns - selected.length);
    const page = BudgetUsageCampaignPage.parse(await store.campaigns(scope, limit, cursor));
    if (!Number.isSafeInteger(page.totalCampaigns) || page.totalCampaigns < 0 || page.campaigns.length > limit
      || (total !== null && total !== page.totalCampaigns)) throw new Error('Budget usage campaign population changed during pagination');
    total = page.totalCampaigns;
    if (page.campaigns.length === 0 && selected.length < Math.min(total, config.maxCampaigns)) throw new Error('Budget usage campaign page is incomplete');
    selected.push(...page.campaigns);
    cursor = page.nextCursor;
    if (selected.length < Math.min(total, config.maxCampaigns) && (cursor === null || cursors.has(cursor))) throw new Error('Budget usage campaign cursor did not advance');
    if (cursor !== null) cursors.add(cursor);
  } while (selected.length < Math.min(total!, config.maxCampaigns));
  const keys = new Set(selected.map(key));
  if (keys.size !== selected.length || selected.length > total!) throw new Error('Budget usage selected campaign identities do not reconcile');
  if (source === 'amazon_ads_api') {
    for (const adProduct of ['SP', 'SB', 'SD'] as const) {
      const campaigns = selected.filter((campaign) => campaign.adProduct === adProduct);
      if (campaigns.length === 0) continue;
      let response: BudgetUsageResult;
      try {
        response = await input.provider.read(input.profile, adProduct, campaigns.map((campaign) => campaign.campaignId));
      } catch (error) {
        // HTTP/transport failures account for the selected product. Parse and identity errors still abort the run.
        if (!(error instanceof AdsApiHttpError) && !(error instanceof AdsApiTimeoutError)) throw error;
        const code = error instanceof AdsApiTimeoutError ? 'provider_timeout' : 'provider_http_failure';
        failures.push(...campaigns.map(({ campaignId }) => ({ adProduct, campaignId, code, details: null })));
        continue;
      }
      const result = BudgetUsageResult.parse(response);
      const receivedAt = clock().toISOString();
      const expected = new Set(campaigns.map((campaign) => campaign.campaignId));
      const accounted = [...result.usage, ...result.failures].map((row) => row.campaignId);
      if (result.requested !== campaigns.length || accounted.length !== campaigns.length
        || new Set(accounted).size !== expected.size || accounted.some((id) => !expected.has(id))) {
        throw new Error('Budget usage provider identities do not reconcile');
      }
      for (const usage of result.usage) {
        const campaign = campaigns.find((candidate) => candidate.campaignId === usage.campaignId)!;
        const providerUpdatedAt = new Date(usage.usageUpdatedTimestamp).toISOString();
        if (providerUpdatedAt > receivedAt) throw new Error('Budget usage provider timestamp is in the future');
        const date = localDate(input.profile.timezone, providerUpdatedAt);
        observations.push(BudgetUsageObservation.parse({
          ...scope, adProduct, campaignId: usage.campaignId, source,
          sourceIdentity: createHash('sha256').update(JSON.stringify([scope.orgId, scope.profileId, adProduct, usage.campaignId, providerUpdatedAt])).digest('hex'),
          currency: campaign.currency, budgetAmount: usage.budget, budgetType: campaign.budgetType,
          period: campaign.budgetType === 'daily' ? { start: date, end: date }
            : campaign.budgetType === 'lifetime' && campaign.startDate && campaign.endDate
              ? { start: campaign.startDate, end: campaign.endDate } : null,
          usagePercent: usage.budgetUsagePercent, providerUpdatedAt, receivedAt, completeness: 'complete',
        }));
      }
      failures.push(...result.failures.map((failure) => ({ ...failure, adProduct })));
    }
  } else {
    const latest = new Map<string, BudgetUsageObservation>();
    for (const raw of await store.stream(scope)) {
      const row = BudgetUsageObservation.parse(raw);
      if (row.orgId !== scope.orgId || row.profileId !== scope.profileId || row.source !== source) throw new Error('Budget usage Stream scope mismatch');
      if (!keys.has(key(row))) continue;
      const previous = latest.get(key(row));
      if (!previous || row.providerUpdatedAt > previous.providerUpdatedAt) latest.set(key(row), row);
    }
    for (const campaign of selected) {
      const observation = latest.get(key(campaign));
      if (observation) observations.push(observation);
      else failures.push({ ...campaign, code: 'missing_stream_observation', details: null });
    }
  }
  if (observations.length + failures.length !== selected.length) throw new Error('Budget usage selected identities were lost');
  const populationComplete = selected.length === total;
  const run = { scope, runId: input.runId, source, receivedAt: clock().toISOString(),
    observations, failures, selected: selected.map(({ adProduct, campaignId }) => ({ adProduct, campaignId })), populationComplete };
  return resultForRun(run, await store.persist(run), input.profile.timezone);
}

function resultForRun(run: BudgetUsageRunInput, rawCounts: BudgetUsageRunCounts, timezone: string) {
  const { observations, failures, selected, populationComplete } = run;
  const counts = BudgetUsageRunCounts.parse(rawCounts);
  if (counts.selected !== selected.length || counts.returned !== observations.length || counts.failed !== failures.length
    || counts.loadedRows !== observations.length || counts.parsedRows !== observations.length
    || counts.sourceRows !== selected.length || counts.refusedRows !== failures.length) throw new Error('Budget usage persistence counts do not reconcile');
  if (observations.length === 0) throw new PermanentJobError('Budget usage run has no provider observation to publish');
  const observedAt = observations.map((row) => new Date(row.providerUpdatedAt).toISOString()).sort()[0]!;
  const dates = observations.map((row) => localDate(timezone, row.providerUpdatedAt)).sort();
  return { ...counts, sourceRunId: run.runId, populationComplete, observedAt, earliestDate: dates[0]!, coveredThrough: dates[dates.length - 1]!,
    status: !populationComplete || failures.length > 0 || observations.some((row) => row.completeness === 'partial') ? 'partial' as const : 'complete' as const };
}

function key(value: { adProduct: AdProduct; campaignId: string }): string { return JSON.stringify([value.adProduct, value.campaignId]); }
function localDate(timezone: string, timestamp: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(timestamp));
}
