// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { buildNgramNegativeReview, ngramCalculationTrace, ngramCoverage, aggregateNgrams } from '@wizard-ads/core';
import { CalculationTrace } from '@wizard-ads/shared';
import { NgramNegativeReviewPanel } from './negative-review';
const source = [{
  searchTerm: 'synthetic component one',
  campaignId: 'synthetic-one',
  adGroupId: 'synthetic-ad-one',
  impressions: 170,
  clicks: 17,
  cost: 37,
  purchases7d: 0,
  sales7d: 0
}, {
  searchTerm: 'synthetic component two',
  campaignId: 'synthetic-two',
  adGroupId: 'synthetic-ad-two',
  impressions: 190,
  clicks: 19,
  cost: 43,
  purchases7d: 0,
  sales7d: 0
}];
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
for (const reason of ['no_sales_over_target_cpa', 'acos_over_ceiling'] as const) it(`shows engine calculation inputs for ${reason}`, () => {
  const rows = source.map(r => ({
    ...r,
    purchases7d: reason === 'acos_over_ceiling' ? 1 : 0,
    sales7d: reason === 'acos_over_ceiling' ? 17 : 0
  }));
  const review = buildNgramNegativeReview(rows, 'synthetic component', 2, {
    targetAcos: 0.37,
    aov: 29
  })!;
  expect(review.candidate.reason).toBe(reason);
  render(<NgramNegativeReviewPanel review={review} profileId="synthetic" period={{
    start: '2026-06-01',
    end: '2026-06-07'
  }} currencyCode="USD" campaignNames={{}} onDismiss={() => { }} />);
  fireEvent.click(screen.getByRole('button', { name: 'View calculation' }));
  const popover = screen.getByRole('dialog');
  expect(popover.textContent).toContain(String(review.targetCostPerOrder));
  expect(popover.textContent).toContain(review.spendRatio.toFixed(1));
  expect(popover.textContent).toContain(reason === 'no_sales_over_target_cpa' ? 'ACOS is undefined' : 'ceiling');
  const trace = CalculationTrace.parse(ngramCalculationTrace(review));
  expect(trace.steps[0]?.inputs).toContainEqual({
    name: 'targetAcos',
    value: 0.37,
    unit: 'ratio'
  });
  expect(trace.steps[2]?.result).toBe(80 / (0.37 * 29));
});
it('posts exactly the reviewed campaign rows and match types, then links the reconciled queue', async () => {
  const review = buildNgramNegativeReview(source, 'synthetic component', 2, {
    targetAcos: 0.37,
    aov: 29
  })!;
  const fetcher = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      created: 2,
      offered: 2
    })
  });
  vi.stubGlobal('fetch', fetcher);
  render(<NgramNegativeReviewPanel review={review} profileId="synthetic" period={{
    start: '2026-06-01',
    end: '2026-06-07'
  }} currencyCode="USD" campaignNames={{}} onDismiss={() => { }} />);
  fireEvent.change(screen.getByLabelText('Negative match 2'), { target: { value: 'negative_exact' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add 2 negatives to change queue' }));
  expect(await screen.findByRole('heading', { name: 'Negative keywords queued' })).toBeDefined();
  const body = JSON.parse(fetcher.mock.calls[0]![1].body);
  expect(body.proposals).toHaveLength(2);
  expect(body.proposals.map((p: { matchType: string }) => p.matchType)).toEqual(['negative_phrase', 'negative_exact']);
  expect(body.proposals[0].gramInputs).toMatchObject({
    targetAcos: 0.37,
    aov: 29,
    spend: 80,
    orders: 0,
    reason: 'no_sales_over_target_cpa'
  });
  expect(screen.getByRole('link', { name: 'Review proposals' })).toBeDefined();
});
it('reconciles coverage for all three gram sizes without summing overlapping spend', () => {
  for (const n of [1, 2, 3]) {
    const grams = aggregateNgrams(source, { sizes: [n] });
    const coverage = ngramCoverage(source, grams);
    expect(coverage.totalTerms).toBe(2);
    expect(coverage.representedTerms).toBe(2);
    expect(coverage.representedSpend).toBe(80);
    expect(coverage.grams).toBe(grams.length);
  }
});
