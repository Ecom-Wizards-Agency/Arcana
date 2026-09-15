// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { researchFacts } from './research-fixture';
import { researchCategoryCounts, researchDemandGroups } from '@wizard-ads/core';
import { QueryResearch } from './research-view';
import { VocabularyEditor } from './vocabulary';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('derives exactly four chart groups while six chip counts retain excluded and unreviewed queries', () => {
  const groups = researchDemandGroups(researchFacts);
  expect(groups.map(g => g.category)).toEqual(['own_brand', 'competitor', 'core', 'head']);
  expect(groups.reduce((n, g) => n + g.searches, 0)).toBe(1000);
  const counts = researchCategoryCounts(researchFacts, [], [], 'synthetic-market');
  expect(counts).toHaveLength(6);
  expect(counts.every(c => c.count === 1)).toBe(true);
  const { container } = render(<QueryResearch profileId="synthetic" marketplaceId="synthetic-market" facts={researchFacts} ppc={[]} vocabulary={[]} />);
  expect(container.querySelectorAll('[data-chart-category]')).toHaveLength(4);
  expect(container.querySelector('[data-chart-category="excluded"]')).toBeNull();
  expect(screen.getByRole('region',{name:'Demand split'}).textContent).toContain('14.3% of everything searched');
  fireEvent.click(screen.getByRole('button', { name: 'Your impression share' }));
  expect(within(screen.getByRole('region', { name: 'Demand split' })).getAllByText('10.0%')).toHaveLength(4);
  fireEvent.click(screen.getByRole('button', { name: 'CTR gap' }));
  const table = screen.getByRole('table', { name: 'Query performance' });
  expect(within(table).getAllByRole('row')[1]?.textContent).toContain('Synthetic query 5');
  fireEvent.click(screen.getByRole('button', { name: 'CVR gap' }));
  expect(within(table).getAllByRole('row')[1]?.textContent).toContain('Synthetic query 5');
});
it('renders absent SQP as not measured without a numeric zero in its charts or metric cells', () => {
  const { container } = render(<QueryResearch profileId="synthetic" marketplaceId="synthetic-market" facts={[]} ppc={[{ searchTerm: 'Synthetic component' }]} vocabulary={[]} />);
  expect(container.querySelectorAll('[data-state="not-measured"]').length).toBeGreaterThan(2);
  expect(screen.getByRole('region', { name: 'Demand split' }).textContent).not.toMatch(/\b0\b/);
  expect(screen.getByRole('table', { name: 'Query performance' }).textContent).not.toMatch(/\b0\b/);
  expect(screen.getAllByText('Search Query Performance is not connected for this profile').length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole('button', { name: 'Head 1' }));
  expect(screen.getByText('Synthetic component')).toBeDefined();
});
it('adds then approves vocabulary through the authenticated route and reconciles the returned count', async () => {
  const id = '11111111-1111-4111-8111-111111111111', entry = {
    id,
    orgId: id,
    marketplaceId: 'synthetic-market',
    kind: 'own_brand_term',
    value: 'Synthetic word',
    normalizedValue: 'synthetic word',
    source: 'operator',
    approved: false,
    reviewedAt: null
  };
  const fetcher = vi.fn().mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      entries: [entry],
      count: 1
    })
  }).mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      entries: [{
        ...entry,
        approved: true,
        reviewedAt: '2026-06-15T12:00:00Z'
      }],
      count: 1
    })
  });
  vi.stubGlobal('fetch', fetcher);
  render(<VocabularyEditor profileId={id} entries={[]} />);
  fireEvent.change(screen.getByLabelText('Word or phrase'), { target: { value: 'Synthetic word' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add word' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Approve Synthetic word' }));
  expect(await screen.findByText('Approved')).toBeDefined();
  expect(JSON.parse(fetcher.mock.calls[1]![1].body)).toEqual({
    action: 'approve',
    profileId: id,
    id
  });
});
