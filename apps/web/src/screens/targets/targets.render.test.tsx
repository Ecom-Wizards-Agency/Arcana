// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { rendered, verifyScreen } from '../render-test-support';
import { descriptor } from './descriptor';
import Screen from './view';
import Loading from '../../../app/targets/[id]/loading';
import SharedError from '../shared-error';

const ready = {
  view: 'ready' as const, currencyCode: 'USD', back: '/grid?entity=targets&view=1.synthetic',
  payload: {
    target: { targetId: 'synthetic', targeting: 'Synthetic keyword', matchType: 'exact', adProduct: 'SP', targetKind: 'keyword', campaignId: 'synthetic-campaign', campaignName: 'Synthetic campaign' },
    totals: { impressions: 100, clicks: 10, spend: 20, sales: 100, orders: 2, units: 2 },
    window: { from: '2026-08-01', to: '2026-08-02' },
    points: [{ date: '2026-08-01', low: 1, median: 2, high: 3, bid: 2, cpc: 2, maxCpc: 3, components: [] }],
  },
  ranks: [{ date: '2026-08-01', asin: 'SYNTHETIC1', organicRank: 12, sponsoredRank: 3 }],
};
verifyScreen(descriptor, [
  { state: 'loading', name: 'renders loading', render: () => <Loading />, text: '' },
  { state: 'error', name: 'renders errors', render: () => <SharedError error={new Error('Synthetic error')} reset={() => {}} />, text: '' },
  { state: 'gated', name: 'renders the agency gate', render: () => <Screen data={{ view: 'gated', state: 'no-database' }} />, text: 'database' },
  { state: 'ready', name: 'renders the synthetic keyword', render: () => <Screen data={ready} />, text: 'Synthetic keyword' },
  { state: 'empty', name: 'renders an empty rank series', render: () => <Screen data={{ ...ready, ranks: [] }} />, text: 'No rank observations measured' },
  { state: 'not-measured', name: 'renders unmeasured ranks', render: () => <Screen data={{ ...ready, ranks: [{ ...ready.ranks[0]!, organicRank: null }] }} />, text: 'Not measured' },
]);
it('renders corridor, spend, ACOS, all rank rows and the exact return URL', () => {
  const host = rendered(<Screen data={ready} />);
  expect(host.querySelector('[aria-label="Bid corridor chart"]')).not.toBeNull();
  expect(host.textContent).toContain('Spend'); expect(host.textContent).toContain('ACOS');
  expect(host.textContent).toContain('20.0%');
  expect(host.querySelectorAll('[aria-label="Rank observations"] tbody tr')).toHaveLength(ready.ranks.length);
  expect(host.querySelector('a')?.getAttribute('href')).toBe(ready.back);
});
