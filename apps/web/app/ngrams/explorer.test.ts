// @vitest-environment jsdom
/**
 * The n-gram explorer, with its drill-down rendered through the Data Grid.
 *
 * jsdom has no layout engine, so the virtualizer is handed one viewport-sized
 * box through the component's `initialGridRect` seam and everything downstream
 * is the production component — the same seam `campaign-workspace.test.ts` and
 * `review.test.ts` use. `scrollTo`, `scrollHeight` and `ResizeObserver` are
 * stubbed for the same reason: without them a scroll can never move the virtual
 * window, and continuous scrolling is exactly what replaced the hand-rolled
 * table this slice removed.
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SearchTermRow } from '@wizard-ads/core';
import { NgramExplorer } from './explorer';

const VIEWPORT = { width: 1400, height: 600 };

class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = StubResizeObserver;
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
  configurable: true,
  get: () => VIEWPORT.width,
});
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  get: () => VIEWPORT.height,
});
Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
  configurable: true,
  get: () => 10_000_000,
});
Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
  configurable: true,
  value(this: HTMLElement, options: ScrollToOptions | number) {
    this.scrollTop = typeof options === 'number' ? options : options.top ?? 0;
    setTimeout(() => this.dispatchEvent(new Event('scroll')), 0);
  },
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: Array<{ unmount: () => void }> = [];

afterEach(() => {
  act(() => {
    for (const root of mounted.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function term(index: number, over: Partial<SearchTermRow> = {}): SearchTermRow {
  const suffix = String(index).padStart(3, '0');
  return {
    searchTerm: `blue widget ${suffix}`,
    impressions: index * 100,
    clicks: index,
    cost: index,
    purchases7d: index % 3,
    sales7d: index * 2,
    campaignId: `campaign-${suffix}`,
    adGroupId: `adgroup-${suffix}`,
    targetId: null,
    matchType: index % 2 === 0 ? 'exact' : 'phrase',
    ...over,
  };
}

function mount(rows: readonly SearchTermRow[]): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push(root);
  act(() =>
    root.render(
      createElement(NgramExplorer, {
        rows,
        scopes: { campaigns: [], tags: [] },
        profileId: '00000000-0000-4000-8000-000000000001',
        currencyCode: 'USD',
        period: { start: '2026-08-01', end: '2026-08-30' },
        initialGridRect: VIEWPORT,
      }),
    ),
  );
  return host;
}

function gramGrid(host: HTMLElement): HTMLElement {
  const grid = host.querySelector<HTMLElement>('[data-testid="grid-shell"]');
  if (grid === null) throw new Error('the gram grid is not rendered');
  return grid;
}

function drilldown(host: HTMLElement): HTMLElement {
  const section = host.querySelector<HTMLElement>('[data-testid="gram-terms"]');
  if (section === null) throw new Error('no gram is selected');
  const grid = section.querySelector<HTMLElement>('[data-testid="grid-shell"]');
  if (grid === null) throw new Error('the drill-down is not a Data Grid');
  return grid;
}

function rows(host: HTMLElement): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>('[data-testid="grid-row"]')];
}

function header(host: HTMLElement, label: string): HTMLElement {
  const element = host.querySelector<HTMLElement>(`[role="columnheader"][aria-label="${label}"]`);
  if (element === null) throw new Error(`no column header labelled '${label}'`);
  return element;
}

function cells(row: HTMLElement): string[] {
  return [...row.querySelectorAll('[role="cell"]')].map((cell) => cell.textContent ?? '');
}

function cellUnder(grid: HTMLElement, row: HTMLElement, label: string): string {
  const index = [...grid.querySelectorAll('[role="columnheader"]')]
    .map((element) => element.getAttribute('aria-label') ?? '')
    .indexOf(label);
  if (index < 0) throw new Error(`no column header labelled '${label}'`);
  return cells(row)[index] ?? '';
}

/** Open the drill-down by clicking the gram the explorer put on top. */
function openGram(host: HTMLElement): void {
  const first = rows(gramGrid(host))[0];
  if (first === undefined) throw new Error('the gram grid rendered no row');
  act(() => first.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

function scroll(grid: HTMLElement, top: number): void {
  const scroller = grid.querySelector<HTMLElement>('[data-testid="grid-scroller"]');
  if (scroller === null) throw new Error('the grid has no scroller');
  act(() => {
    scroller.scrollTop = top;
    scroller.dispatchEvent(new Event('scroll'));
  });
}

describe('n-gram drill-down', () => {
  it('renders the search terms behind a gram through the Data Grid, formatted by the shared formatters', () => {
    const host = mount([
      term(1, { searchTerm: 'blue widget large', cost: 1234.5, sales7d: 9876.25, clicks: 4000, purchases7d: 1000 }),
      term(2, { searchTerm: 'blue widget small' }),
    ]);
    openGram(host);

    const grid = drilldown(host);
    // The drill-down is a grid, not a hand-rolled table: the section holds no
    // <table> at all any more.
    expect(host.querySelector('[data-testid="gram-terms"] table')).toBeNull();

    const row = rows(grid).find((candidate) =>
      cells(candidate).some((text) => text.includes('blue widget large')),
    );
    expect(row).toBeDefined();
    // Money in the profile's currency with a thousands separator, not
    // `cost.toFixed(2)`; integers grouped, not printed raw.
    expect(cellUnder(grid, row!, 'Spend')).toBe('$1,234.50');
    expect(cellUnder(grid, row!, 'Sales')).toBe('$9,876.25');
    expect(cellUnder(grid, row!, 'Clicks')).toBe('4,000');
    expect(cellUnder(grid, row!, 'Orders')).toBe('1,000');
    // Ratios the raw table never showed at all, derived from the summed bases.
    expect(cellUnder(grid, row!, 'CVR')).toBe('25.0%');
    expect(cellUnder(grid, row!, 'RPC')).toBe('$2.47');
    expect(cellUnder(grid, row!, 'ACOS')).toBe('12.5%');
  });

  it('sorts the drill-down on a header click and holds every term in one continuous scroll', () => {
    const host = mount(Array.from({ length: 400 }, (_, index) => term(index + 1)));
    openGram(host);
    const grid = drilldown(host);

    // Spend descending is the opening order, and the DOM holds a viewport of
    // the 400 terms rather than all of them.
    const rendered = rows(grid);
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(400);
    expect(cellUnder(grid, rendered[0]!, 'Search term')).toBe('blue widget 400');
    expect(grid.textContent).toContain('400 of 400 search terms');

    // A header click reverses it, and a scroll — not a pager — reaches the end.
    act(() => header(grid, 'Spend').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(header(grid, 'Spend').getAttribute('aria-sort')).toBe('ascending');
    expect(cellUnder(grid, rows(grid)[0]!, 'Search term')).toBe('blue widget 001');
    scroll(grid, 400 * 40);
    expect(
      rows(grid).some((row) => cellUnder(grid, row, 'Search term') === 'blue widget 400'),
    ).toBe(true);
  });

  it('proposes exactly the terms ticked in the drill-down', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ created: 1, offered: 1 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const host = mount([
      term(1, { searchTerm: 'blue widget large' }),
      term(2, { searchTerm: 'blue widget small' }),
    ]);
    openGram(host);
    const grid = drilldown(host);

    const checkbox = grid.querySelector<HTMLInputElement>(
      'input[aria-label="Select blue widget large"]',
    );
    expect(checkbox).not.toBeNull();
    act(() => checkbox!.click());

    const propose = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Propose selected as negatives',
    );
    expect(propose).toBeDefined();
    await act(async () => {
      propose!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body)) as {
      proposals: Array<{ searchTerm: string }>;
    };
    expect(body.proposals.map((proposal) => proposal.searchTerm)).toEqual(['blue widget large']);
    expect(host.querySelector('[data-testid="propose-result"]')?.textContent).toContain(
      'Proposed 1 of 1 negatives',
    );
  });
});
