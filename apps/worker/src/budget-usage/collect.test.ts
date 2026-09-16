import { describe, expect, it, vi } from 'vitest';
import { AdsApiHttpError, AdsApiParseError } from '@wizard-ads/ads-api';
import { BudgetUsageConfig, type BudgetUsageCampaign, type BudgetUsageObservation, type BudgetUsageRunInput } from '@wizard-ads/shared';
import { collectBudgetUsage, type BudgetUsageCollectorStore, type BudgetUsageCollectorInput } from './collect.js';
import { IngestionRegistry } from '../ingestion-registry.js';
import { registerBudgetUsageSources } from './register.js';
import { ingestionLaneJobTypes, INGESTION_SOURCES } from '../ingestion-sources.js';
import type { ClaimedJob } from '@wizard-ads/db';

const scope = { orgId: '10101010-1010-4010-8010-101010101010', profileId: '20202020-2020-4020-8020-202020202020' };
const runId = '30303030-3030-4030-8030-303030303030';
const now = '2026-09-15T12:00:00.000Z';
const providerTime = '2026-09-15T10:00:00.000Z';
function campaign(campaignId: string, adProduct: 'SP' | 'SB' | 'SD' = 'SP'): BudgetUsageCampaign {
  return { campaignId, adProduct, campaignName: null, currency: 'USD', budgetType: 'daily', startDate: null, endDate: null };
}
function counts(input: BudgetUsageRunInput) {
  return { selected: input.selected.length, requested: input.selected.length, returned: input.observations.length, failed: input.failures.length,
    sourceRows: input.selected.length, parsedRows: input.observations.length, refusedRows: input.failures.length,
    loadedRows: input.observations.length, existingRows: 0, verifiedLoadedRows: input.observations.length };
}
function setup(campaigns = [campaign('one')]) {
  const config = BudgetUsageConfig.parse({ apiEnabled: true, streamEnabled: true, pageSize: 17 });
  const persist = vi.fn(async (input: BudgetUsageRunInput) => counts(input));
  const store: BudgetUsageCollectorStore = {
    config: vi.fn(async () => config),
    replay: vi.fn(async () => null),
    campaigns: vi.fn(async (_scope, limit, cursor) => {
      const start = Number(cursor ?? 0);
      return { campaigns: campaigns.slice(start, start + limit), nextCursor: start + limit < campaigns.length ? String(start + limit) : null, totalCampaigns: campaigns.length };
    }),
    stream: vi.fn(async () => []), persist,
  };
  const read = vi.fn(async (_profile, _product, ids: readonly string[]) => ({ requested: ids.length, failures: [],
    usage: ids.map((campaignId, i) => ({ campaignId, budget: i + 10, budgetUsagePercent: i === 0 ? 0 : 120, usageUpdatedTimestamp: providerTime })) }));
  const input: BudgetUsageCollectorInput = { scope, profile: { id: scope.profileId, orgId: scope.orgId, amazonProfileId: 'synthetic-profile', region: 'NA', currencyCode: 'USD', timezone: 'America/Los_Angeles' },
    runId, source: 'amazon_ads_api', enabled: true, store, provider: { read }, now: () => new Date(now) };
  return { input, config, store, read, persist };
}

describe('budget usage collectors', () => {
  it('registers exactly two ordered budget adapters and keeps report lane claims unchanged', () => {
    expect(INGESTION_SOURCES.filter((source) => source.reportType === 'campaign_budget_usage').map((source) => [source.jobType, source.source]))
      .toEqual([['budget_usage.collect', 'amazon_ads_api'], ['budget_usage.stream', 'amazon_marketing_stream']]);
    expect(ingestionLaneJobTypes('integrations')).toEqual(expect.arrayContaining(['budget_usage.collect', 'budget_usage.stream', 'marketing_stream.normalize']));
    expect(ingestionLaneJobTypes('evo-report')).toEqual(['creative.sync', 'report.request', 'report.poll', 'report.fetch']);
    expect(BudgetUsageConfig.parse({})).toMatchObject({ apiEnabled: false, streamEnabled: false });
  });
  it.each(['amazon_ads_api', 'amazon_marketing_stream'] as const)('performs no source work when %s is deployment-disabled', async (source) => {
    const h = setup();
    await expect(collectBudgetUsage({ ...h.input, source, enabled: false })).rejects.toThrow('disabled');
    expect(h.store.config).not.toHaveBeenCalled(); expect(h.store.campaigns).not.toHaveBeenCalled(); expect(h.read).not.toHaveBeenCalled(); expect(h.persist).not.toHaveBeenCalled();
  });
  it('checks profile source enablement before campaign selection', async () => {
    const h = setup(); h.config.apiEnabled = false;
    await expect(collectBudgetUsage(h.input)).rejects.toThrow('disabled');
    expect(h.store.campaigns).not.toHaveBeenCalled(); expect(h.read).not.toHaveBeenCalled();
  });
  it('pages and reconciles more than one API batch across all three products', async () => {
    const h = setup([...Array.from({ length: 110 }, (_, i) => campaign(`sp-${i}`)), campaign('sb-one', 'SB'), campaign('sd-one', 'SD')]);
    const result = await collectBudgetUsage(h.input);
    expect(result).toMatchObject({ selected: 112, requested: 112, returned: 112, failed: 0, loadedRows: 112, verifiedLoadedRows: 112, populationComplete: true });
    expect(h.store.campaigns).toHaveBeenCalledTimes(7);
    expect(h.read.mock.calls.map((call) => [call[1], call[2].length])).toEqual([['SP', 110], ['SB', 1], ['SD', 1]]);
    const saved = h.persist.mock.calls[0]![0];
    expect(saved.observations).toHaveLength(saved.selected.length);
    expect(saved.observations[0]).toMatchObject({ usagePercent: 0, budgetAmount: 10, providerUpdatedAt: providerTime, receivedAt: now, period: { start: '2026-09-15', end: '2026-09-15' } });
    expect(saved.observations[1]?.usagePercent).toBe(120);
  });
  it.each(['missing', 'duplicate', 'mismatch', 'malformed'] as const)('fails closed on %s provider output', async (kind) => {
    const h = setup([campaign('one'), campaign('two')]);
    h.input.provider.read = async () => ({ requested: 2, failures: [], usage: (kind === 'missing' ? ['one'] : kind === 'duplicate' ? ['one', 'one'] : kind === 'mismatch' ? ['one', 'other'] : ['one', 'two'])
      .map((campaignId) => ({ campaignId, budget: 10, budgetUsagePercent: kind === 'malformed' ? NaN : 0, usageUpdatedTimestamp: providerTime })) });
    await expect(collectBudgetUsage(h.input)).rejects.toThrow(); expect(h.persist).not.toHaveBeenCalled();
  });
  it('publishes partial coverage only after exact persisted counts, retaining provider time', async () => {
    const h = setup([campaign('one'), campaign('two')]);
    h.input.provider.read = async () => ({ requested: 2, usage: [{ campaignId: 'one', budget: 0, budgetUsagePercent: 0, usageUpdatedTimestamp: '2026-08-01T10:00:00Z' }], failures: [{ campaignId: 'two', code: 'refused', details: null }] });
    const producer = vi.fn(async () => ({ offered: 1, written: 1, unchanged: 0 }));
    const registry = new IngestionRegistry(producer);
    registerBudgetUsageSources(registry, { store: h.store, provider: h.input.provider, apiEnabled: true, streamEnabled: false, now: h.input.now });
    await registry.dispatch({ job: { ...scope, id: runId } as ClaimedJob, payload: { ...scope, type: 'budget_usage.collect' }, profile: h.input.profile });
    expect(producer).toHaveBeenCalledWith(expect.objectContaining({ sourceRunId: runId, status: 'partial', sourceRows: 2, parsedRows: 1, refusedRows: 1, loadedRows: 1, observedAt: '2026-08-01T10:00:00.000Z' }), 1);
    expect(h.persist.mock.calls[0]![0].failures[0]).toMatchObject({ campaignId: 'two', code: 'refused' });
  });
  it('refuses coverage if a persisted output is dropped', async () => {
    const h = setup(); h.store.persist = async (input) => ({ ...counts(input), verifiedLoadedRows: 0 });
    await expect(collectBudgetUsage(h.input)).rejects.toThrow('counts');
  });
  it('retains other product successes after a transport failure and excludes raw error details', async () => {
    const h = setup([campaign('sp-one'), campaign('sb-one', 'SB'), campaign('sd-one', 'SD')]);
    h.input.provider.read = async (_profile, adProduct, ids) => {
      if (adProduct === 'SB') throw new AdsApiHttpError('private transport detail', 0, 'private body', 3);
      return { requested: ids.length, failures: [], usage: ids.map((campaignId) => ({ campaignId, budget: 10, budgetUsagePercent: 0, usageUpdatedTimestamp: providerTime })) };
    };
    expect(await collectBudgetUsage(h.input)).toMatchObject({ selected: 3, returned: 2, failed: 1, status: 'partial' });
    expect(h.persist.mock.calls[0]![0].failures).toEqual([{ adProduct: 'SB', campaignId: 'sb-one', code: 'provider_http_failure', details: null }]);
    h.persist.mockClear();
    h.input.provider.read = async () => { throw new AdsApiParseError('malformed response'); };
    await expect(collectBudgetUsage(h.input)).rejects.toThrow('malformed response');
    expect(h.persist).not.toHaveBeenCalled();
  });
  it('records all failures durably without zero usage or a coverage receipt', async () => {
    const h = setup(); h.input.provider.read = async () => ({ requested: 1, usage: [], failures: [{ campaignId: 'one', code: 'refused', details: null }] });
    await expect(collectBudgetUsage(h.input)).rejects.toThrow('no provider observation');
    expect(h.persist.mock.calls[0]![0].observations).toEqual([]);
  });
  it('marks a capped campaign population partial', async () => {
    const h = setup([campaign('one'), campaign('two')]); h.config.maxCampaigns = 1;
    expect(await collectBudgetUsage(h.input)).toMatchObject({ selected: 1, populationComplete: false, status: 'partial' });
  });
  it('reads Stream observations without calling Amazon or creating hourly traffic', async () => {
    const h = setup();
    const observation: BudgetUsageObservation = { ...scope, adProduct: 'SP', campaignId: 'one', source: 'amazon_marketing_stream', sourceIdentity: 'bound-event', currency: 'USD', budgetAmount: null, budgetType: null, period: null, usagePercent: 0, providerUpdatedAt: providerTime, receivedAt: providerTime, completeness: 'complete' };
    h.store.stream = async () => [observation];
    expect(await collectBudgetUsage({ ...h.input, source: 'amazon_marketing_stream' })).toMatchObject({ returned: 1, failed: 0 });
    expect(h.read).not.toHaveBeenCalled();
    expect(h.persist.mock.calls[0]![0].observations).toEqual([observation]);
    h.store.stream = async () => [{ ...observation, orgId: runId }];
    await expect(collectBudgetUsage({ ...h.input, source: 'amazon_marketing_stream' })).rejects.toThrow('scope mismatch');
  });
  it('rejects cross-profile context before reading configuration', async () => {
    const h = setup();
    await expect(collectBudgetUsage({ ...h.input, scope: { ...scope, profileId: runId } })).rejects.toThrow('scope mismatch');
    expect(h.store.config).not.toHaveBeenCalled();
  });
  it('uses response receipt time when Amazon recomputes usage while the request is in flight', async () => {
    const h = setup();
    let clock = new Date(now);
    h.input.now = () => clock;
    h.input.provider.read = async () => {
      clock = new Date('2026-09-15T12:00:01.000Z');
      return { requested: 1, failures: [], usage: [{ campaignId: 'one', budget: 10, budgetUsagePercent: 0, usageUpdatedTimestamp: '2026-09-15T12:00:00.500Z' }] };
    };
    await expect(collectBudgetUsage(h.input)).resolves.toMatchObject({ returned: 1, observedAt: '2026-09-15T12:00:00.500Z' });
    expect(h.persist.mock.calls[0]![0]).toMatchObject({ receivedAt: '2026-09-15T12:00:01.000Z', observations: [expect.objectContaining({ receivedAt: '2026-09-15T12:00:01.000Z' })] });
  });
  it('recovers coverage from a verified saved run without refetching or advancing receipt/provider time', async () => {
    const h = setup();
    const first = await collectBudgetUsage(h.input);
    const saved = h.persist.mock.calls[0]![0];
    h.store.replay = async () => ({ input: saved, counts: counts(saved) });
    h.read.mockClear(); h.persist.mockClear();
    const replay = await collectBudgetUsage({ ...h.input, now: () => new Date('2026-09-16T12:00:00Z') });
    expect(replay).toEqual(first);
    expect(h.read).not.toHaveBeenCalled(); expect(h.persist).not.toHaveBeenCalled();
    h.store.replay = async () => ({ input: saved, counts: { ...counts(saved), verifiedLoadedRows: 0 } });
    await expect(collectBudgetUsage(h.input)).rejects.toThrow('counts');
  });
});
