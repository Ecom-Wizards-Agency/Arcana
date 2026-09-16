import { beforeEach, expect, it, vi } from 'vitest';
import { BudgetUsageConfig } from '@wizard-ads/shared';
import type { ScreenActor } from '../../server/page-read';
import { withoutBudget } from './fixtures';
import { load } from './load';
const mocks = vi.hoisted(() => ({
  provider: vi.fn(async () => ({ rows: [], runs: [], totalCount: 0 })), performance: vi.fn(), role: vi.fn(), proposals: vi.fn(), events: vi.fn(), market: vi.fn(),
  spend: vi.fn().mockResolvedValue(null), retail: vi.fn().mockResolvedValue({ state: 'unavailable', reason: 'Disabled', report: null }), campaigns: vi.fn(), ranks: vi.fn(), month: vi.fn(), budget: vi.fn(), portfolios: vi.fn(),
}));
vi.mock('../cockpit/load', () => ({ load: mocks.performance }));
vi.mock('../../server/org-role', () => ({ requireOrgRole: mocks.role }));
vi.mock('@wizard-ads/db', () => ({ readStreamConsumerSource: vi.fn(async()=>({events:[],scope:{orgId:'00000000-0000-4000-8000-000000000001',profileId:'00000000-0000-4000-8000-000000000002',amazonProfileId:'313',region:'EU'},graph:{observations:[],associations:[],persistedObservations:0,persistedAssociations:0},truncated:false})), readStreamExtensionEvidence: vi.fn(async () => ({ events: [], count: 0, source: 'amazon_marketing_stream', completeness: 'missing', selectionAuthority: false })), readProviderEvidence: mocks.provider, readSpReportEvidence: mocks.retail, readSpRetailSpendEvidence: mocks.spend, listRecommendations: mocks.proposals, listHomeInsights: mocks.events, listHomeMarketGaps: mocks.market, readBudgetUsageEvidence: mocks.budget, listPortfolioSpendEvidence: mocks.portfolios }));
vi.mock('../../../app/_lib/dashboard-data', () => ({ loadCampaignDailyRows: mocks.campaigns, loadHomeRankWatch: mocks.ranks, loadProfileDailyRows: mocks.month }));

beforeEach(() => {
  mocks.budget.mockResolvedValue({ orgId: 'synthetic-org', profileId: withoutBudget.profile.id, config: BudgetUsageConfig.parse({}), campaigns: [], observations: [], sources: [], totalCampaigns: 0 });
  mocks.portfolios.mockResolvedValue([]);
});

it('loads the whole pacing month and derives viewer authority from the authenticated read', async () => {
  const base = { ...withoutBudget, period: { start: '2026-06-25', end: '2026-06-28' }, today: '2026-06-29',
    profile: { ...withoutBudget.profile, monthlyBudget: 3000 }, accountRows: [] };
  mocks.performance.mockResolvedValue({ view: 'ready', props: base });
  mocks.role.mockResolvedValue('viewer');
  for (const query of [mocks.proposals, mocks.events, mocks.market, mocks.campaigns, mocks.ranks]) query.mockResolvedValue([]);
  mocks.month.mockResolvedValue([{ date: '2026-06-01', spend: 100 }, { date: '2026-06-28', spend: 200 }]);
  const handle = {};
  const actor = { orgId: 'synthetic-org', userId: 'synthetic-user' };
  const read = vi.fn(async (query) => query(handle, actor));
  const data = await load({ read } as unknown as ScreenActor, { searchParams: {}, params: {} });
  expect(read).toHaveBeenCalledTimes(1);
  expect(mocks.role).toHaveBeenCalledWith(handle, actor);
  expect(mocks.provider).toHaveBeenCalledWith(handle, { orgId: actor.orgId, profileId: base.profile.id, consumer: 'home' });
  expect(mocks.budget).toHaveBeenCalledWith(handle, { orgId: actor.orgId, profileId: base.profile.id });
  expect(mocks.portfolios).toHaveBeenCalledWith(handle, { orgId: actor.orgId, profileId: base.profile.id, asOf: '2026-06-28' });
  expect(mocks.month).toHaveBeenCalledWith(handle, actor.orgId, base.profile.id, base.profile.label, { start: '2026-06-01', end: '2026-06-28' });
  expect(mocks.events).toHaveBeenCalledWith(handle, { orgId: actor.orgId, profileId: base.profile.id, start: '2026-06-23', end: '2026-06-29' });
  expect(mocks.ranks).toHaveBeenCalledWith(handle, actor.orgId, base.profile.id, '2026-06-28');
  expect(data.view).toBe('ready');
  if (data.view !== 'ready') throw new Error('Expected ready Home');
  expect(data.props.home.canDecide).toBe(false);
  expect(data.props.pacing?.mtdSpend).toBe(300);
  expect(data.props.pacing?.coverageComplete).toBe(false);
});
it('preserves the base gate without reading supplementary data', async () => {
  mocks.performance.mockResolvedValue({ view: 'no-database', props: {} });
  const read = vi.fn();
  expect(await load({ read } as unknown as ScreenActor, { searchParams: {}, params: {} })).toEqual({ view: 'no-database', props: {} });
  expect(read).not.toHaveBeenCalled();
});

it('uses selected profile facts, including recent days, and the topbar custom comparison', async () => {
  const daily = (date: string, spend: number, sales: number) => ({ date, spend, sales, impressions: 400, clicks: 20, orders: 2 });
  mocks.performance.mockResolvedValue({ view: 'ready', props: { ...withoutBudget,
    period: { start: '2026-06-25', end: '2026-06-28' }, today: '2026-06-29',
    accountRows: [daily('2026-06-24', 900, 900), daily('2026-06-25', 10, 50), daily('2026-06-28', 30, 50)],
  } });
  mocks.role.mockResolvedValue('admin');
  for (const query of [mocks.proposals, mocks.events, mocks.market, mocks.campaigns, mocks.ranks]) query.mockResolvedValue([]);
  mocks.month.mockImplementation(async (_handle, _org, _profile, _label, period) => period.start === '2026-05-01'
    ? [daily('2026-05-01', 20, 200)] : []);
  const read = vi.fn(async (query) => query({}, { orgId: 'synthetic-org', userId: 'synthetic-user' }));
  const data = await load({ read } as unknown as ScreenActor, { searchParams: { compareFrom: '2026-05-01', compareTo: '2026-05-04' }, params: {} });
  if (data.view !== 'ready') throw new Error('Expected ready Home');
  expect(data.props.home.comparison).toEqual({ start: '2026-05-01', end: '2026-05-04' });
  expect(data.props.home.tiles.find((tile) => tile.metric === 'spend')).toMatchObject({ value: 40, prev: 20, deltaPct: 1 });
  expect(data.props.home.tiles.find((tile) => tile.metric === 'acos')).toMatchObject({ value: 0.4, prev: 0.1 });
  expect(data.props.home.breakEvenAcos).toBeNull();
});

it('passes independently verified seller spend and both retail periods through the authenticated read', async () => {
  const source = { state: 'partial' as const, reason: 'Synthetic evidence', report: null };
  const spend = { orgId: 'synthetic-org', sellingPartnerId: 'synthetic-seller', marketplaceId: 'synthetic-market', currency: 'EUR',
    start: '2026-06-25', end: '2026-06-28', scope: 'seller' as const, complete: true, rows: [{ date: '2026-06-25', spend: 10 }] };
  mocks.retail.mockResolvedValue(source); mocks.spend.mockResolvedValue(spend);
  mocks.performance.mockResolvedValue({ view: 'ready', props: { ...withoutBudget, period: { start: spend.start, end: spend.end }, today: '2026-06-29', accountRows: [] } });
  const handle = {}, actor = { orgId: spend.orgId, userId: 'synthetic-user' };
  const read = vi.fn(async query => query(handle, actor));
  const data = await load({ read } as unknown as ScreenActor, { searchParams: {}, params: {} });
  if (data.view !== 'ready') throw new Error('Expected ready Home');
  expect(data.props.home.retail).toEqual(source); expect(data.props.home.previousRetail).toEqual(source);
  expect(data.props.home.retailSpend).toEqual(spend);
  expect(mocks.spend).toHaveBeenCalledWith(handle, { orgId: actor.orgId, profileId: withoutBudget.profile.id, start: spend.start, end: spend.end });
});
