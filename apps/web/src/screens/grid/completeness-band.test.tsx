// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { tokens } from '@wizard-ads/ui';
import type { SavedView } from '@wizard-ads/ui';
import type { GridFeedCoverage } from '@wizard-ads/shared';
import { PerformanceSummary } from './performance-chrome';
import { coverageFor, type CoverageRow } from './data-evidence';

const view: SavedView = { id: 'test', name: 'Test', entity: 'targets', columns: [], pinned: [], widths: {}, filter: { groups: [] }, sort: [], groupBy: [], dateRange: null, updatedAt: '' };
// WP-324: what the report lifecycle now records for two loads with a two-day gap between them.
const verified: CoverageRow = { report_type: 'spTargeting', earliest_returned_date: '2026-09-01', latest_loaded_date: '2026-09-07', availability_start_date: null, missing_dates: ['2026-09-04', '2026-09-05'], status: 'complete', counts_match: true };

function band(feeds: GridFeedCoverage[]) {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(createElement(PerformanceSummary, {
    rows: [], currencyCode: 'USD', profileId: 'synthetic', onChange: () => {}, view,
    performance: { feeds, unattributed: null, rankDays: {} },
  }));
  const section = host.querySelector('[data-testid="grid-provenance"]');
  const feed = (name: string) => [...(section?.querySelectorAll('b') ?? [])].find((chip) => chip.textContent === name);
  return { section, feed };
}

it('shows the days held per feed from verified coverage, and not measured only where none is held', () => {
  const feeds = (['PPC', 'RANK', 'SQP'] as const).map((feed) => coverageFor(feed, [verified], '2026-09-01', '2026-09-07'));
  const { section, feed } = band(feeds);
  expect(section?.textContent).toContain('2026-09-01 – 2026-09-07 · 5 of 7 days held');
  expect(section?.textContent).not.toContain('Advertising performance not measured');
  expect(feed('PPC')?.getAttribute('style')).toContain(`color:${tokens.color.warn}`);
  expect(feed('PPC')?.nextElementSibling?.textContent).toBe('2026-09-01 – 2026-09-07 · 5 of 7 days held');
  expect(feed('RANK')?.nextElementSibling?.textContent).toBe('Organic rank not measured in this range.');
  expect(feed('SQP')?.nextElementSibling?.textContent).toBe('No complete, counted SQP weeks measured in this range.');

  const held = band([coverageFor('PPC', [verified], '2026-09-06', '2026-09-07')]);
  expect(held.feed('PPC')?.nextElementSibling?.textContent).toBe('2026-09-06 – 2026-09-07 · 2 of 2 days held');
  expect(held.feed('PPC')?.getAttribute('style')).toContain(`color:${tokens.color.good}`);

  const gap = band([coverageFor('PPC', [verified], '2026-09-04', '2026-09-05')]);
  expect(gap.feed('PPC')?.nextElementSibling?.textContent).toBe('Advertising performance not measured in this range.');
  expect(gap.feed('PPC')?.getAttribute('style')).toContain(`color:${tokens.color.bad}`);
});
