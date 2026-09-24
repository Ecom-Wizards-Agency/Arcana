// @vitest-environment jsdom
/**
 * WP-316 on Target 360: date-keyed tables open on the latest day (V18), and the
 * target, its type, kind and placement components read in words (V19, D3, D6).
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TARGET_EXPRESSION_LABELS, TARGET_EXPRESSION_TYPES } from '@wizard-ads/shared';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { BidHistoryModal } from '../../ui/bid-history-modal';
import Screen from './view';
import { targetFixture } from './fixtures';
import { newestFirst } from './table-order';

vi.mock('next/navigation', () => ({ usePathname: () => '/', useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));
afterEach(cleanup);

const ready = { ...targetFixture, view: 'ready' as const, currencyCode: 'USD', back: '/grid?entity=targets', savedView: null };
const CODE_SHAPE = /\b(?:[a-z]+_[a-z_]+|[A-Z]+_[A-Z_]+)\b/;

function datesIn(table: HTMLElement): string[] {
  return within(table).getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell')[0]!.textContent ?? '');
}

describe('newest first where dates are the row key (V18)', () => {
  it('orders performance, rank and change tables from the latest day, charts unchanged', () => {
    const data = {
      ...ready,
      ranks: [{ date: '2026-08-11', asin: 'SYNTHETIC1', organicRank: 4, sponsoredRank: null }, { date: '2026-08-13', asin: 'SYNTHETIC1', organicRank: 1, sponsoredRank: 3 }, { date: '2026-08-12', asin: 'SYNTHETIC1', organicRank: 2, sponsoredRank: null }],
      changes: [{ id: '1', date: '2026-08-01', field: 'bid', oldValue: '4', newValue: '5', source: 'sync' }, { id: '2', date: '2026-08-09', field: 'bid', oldValue: '5', newValue: '6', source: 'sync' }],
    };
    render(<Screen data={data} />);
    const expected = [...ready.performance].map((row) => row.date).sort().reverse();
    fireEvent.click(screen.getByRole('tab', { name: 'Performance' }));
    const performance = screen.getByRole('tabpanel').querySelector('table')!;
    expect(datesIn(performance)).toEqual(expected);
    expect(datesIn(performance)).toHaveLength(ready.performance.length);
    fireEvent.click(screen.getByRole('tab', { name: 'Rank' }));
    expect(datesIn(screen.getByRole('region', { name: 'Rank observations' }).querySelector('table')!)).toEqual(['2026-08-13', '2026-08-12', '2026-08-11']);
    fireEvent.click(screen.getByRole('tab', { name: 'Changes' }));
    expect(datesIn(screen.getByRole('tabpanel').querySelector('table')!)).toEqual(['2026-08-09', '2026-08-01']);
    // The loader order the charts read is untouched.
    expect(data.ranks.map((row) => row.date)).toEqual(['2026-08-11', '2026-08-13', '2026-08-12']);
  });

  it('keeps rows that share a date in their loaded order', () => {
    const rows = [{ date: '2026-08-01', id: 'a' }, { date: '2026-08-02', id: 'b' }, { date: '2026-08-01', id: 'c' }];
    expect(newestFirst(rows).map((row) => row.id)).toEqual(['b', 'a', 'c']);
    expect(rows.map((row) => row.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('Target 360 labels (V19, D3, D6)', () => {
  it('names every expression target, its type and kind in words, never the code', () => {
    let checked = 0;
    for (const type of TARGET_EXPRESSION_TYPES) {
      const target = { ...ready.payload.target, targeting: `${type}="B000SYN001"`, matchType: null, targetKind: 'product target' };
      render(<Screen data={{ ...ready, payload: { ...ready.payload, target } }} />);
      const heading = screen.getByRole('heading', { level: 1 });
      expect(heading.textContent).toBe(`${TARGET_EXPRESSION_LABELS[type]}: B000SYN001`);
      const header = heading.closest('header')!;
      expect(header.textContent).not.toContain(type);
      expect(header.textContent).not.toMatch(CODE_SHAPE);
      expect(header.textContent).toMatch(/(Automatic|Product|Theme|Audience) target/);
      cleanup();
      checked += 1;
    }
    expect(checked).toBe(TARGET_EXPRESSION_TYPES.length);
  });

  it('reads a keyword with its match type, and placement components by name', () => {
    const points = ready.payload.points.map((point) => ({ ...point, components: [{ name: 'top_of_search', pct: 50 }, { name: 'rest Of Search', pct: 0 }, { name: 'productPages', pct: 10 }] }));
    render(<Screen data={{ ...ready, payload: { ...ready.payload, points } }} />);
    const header = screen.getByRole('heading', { level: 1 }).closest('header')!;
    expect(header.textContent).toContain('Synthetic keyword');
    expect(header.textContent).toContain('Phrase · Keyword');
    const components = screen.getByRole('button', { name: 'Placement components' }).parentElement!;
    expect(components.textContent).toContain('Top of search +50%');
    expect(components.textContent).toContain('Rest of search 0%');
    expect(components.textContent).toContain('Product pages +10%');
    expect(components.textContent).not.toMatch(CODE_SHAPE);
  });
});

describe('Target 360 drawer title (V19)', () => {
  it('names an automatic target in words in the drawer and its dialog label', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const target = { ...ready.payload.target, targeting: 'QUERY_HIGH_REL_MATCHES', matchType: 'close_match', targetKind: 'product target' };
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...targetFixture, payload: { ...ready.payload, target } })));
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => { root.render(createElement(BidHistoryModal, { profileId: targetFixture.profileId, targetId: 'synthetic', window: { start: '2026-08-01', end: '2026-08-13' }, currencyCode: 'USD', onClose: vi.fn() })); });
    await vi.waitFor(() => expect(host.querySelector('h1')?.textContent).toBe('Close match'));
    expect(host.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Close match');
    expect(host.textContent).not.toMatch(CODE_SHAPE);
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });
});
