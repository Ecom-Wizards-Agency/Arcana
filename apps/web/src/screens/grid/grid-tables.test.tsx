// @vitest-environment jsdom
/**
 * WP-316 on the real `/grid` workspace: readable target, match, kind and
 * placement labels with no code reaching the DOM, the Phrase column, the
 * tri-state select-all, and a resized width that persists into the saved view
 * and comes back on the next visit.
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MATCH_TYPE_LABELS, MatchType, PLACEMENT_LABELS, Placement, TARGET_EXPRESSION_TYPES, parseGridView } from '@wizard-ads/shared';
import { MemoryViewStore, columnsFor, type EntityLevel, type FreshnessAssessment, type GridRow, type SavedView } from '@wizard-ads/ui';
import { GridWorkspace } from '../../../app/grid/grid-client';
import { scopeRows } from './performance-model';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), useSearchParams: () => new URLSearchParams(window.location.search) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no layout; give the virtualized grid one viewport, as the ui suites do.
class StubResizeObserver { observe(): void {} unobserve(): void {} disconnect(): void {} }
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = StubResizeObserver;
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 4000 });
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 4000 });

const mounted: Array<{ unmount: () => void }> = [];
afterEach(() => {
  act(() => { for (const root of mounted.splice(0)) root.unmount(); });
  document.body.replaceChildren();
  window.history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
});

const freshness: FreshnessAssessment = { tone: 'good', headline: 'Fresh', details: [], staleTypes: [], lossyTypes: [], coversThrough: '2026-08-29' };
const zero = { impressions: 100, clicks: 5, spend: 10, sales: 40, orders: 1, units: 1 };

const keywordRows: GridRow[] = MatchType.options.map((matchType, index) => ({ id: `target:keyword-${index}`, currencyCode: 'USD', totals: zero, comparison: null,
  dimensions: { target_id: `keyword-${index}`, targeting: `synthetic phrase ${index}`, target_kind: 'keyword', match_type: matchType, target_state: 'enabled', campaign_name: 'Synthetic campaign', not_the_query: matchType === 'broad' } }));
const expressionRows: GridRow[] = TARGET_EXPRESSION_TYPES.map((type, index) => ({ id: `target:expression-${index}`, currencyCode: 'USD', totals: zero, comparison: null,
  dimensions: { target_id: `expression-${index}`, targeting: index % 2 ? type : `${type}="B000SYN${String(index).padStart(3, '0')}"`, target_kind: 'target', match_type: null, target_state: 'enabled', campaign_name: 'Synthetic campaign', not_the_query: true } }));
const placementRows: GridRow[] = Placement.options.map((placement, index) => ({ id: `placement:c-1:${placement}`, currencyCode: 'USD', totals: { ...zero, spend: index + 1 }, comparison: null,
  dimensions: { placement, campaign_name: 'Synthetic campaign', campaign_id: 'c-1', ad_product: 'SP', placement_modifier: null } }));

function view(entity: EntityLevel, columns: string[]): SavedView {
  return { id: 'default', name: 'Default', entity, columns, pinned: [columnsFor(entity).find((column) => column.pinned)!.id], widths: {}, filter: { groups: [] }, sort: [], groupBy: [], dateRange: null, updatedAt: '2026-08-29T00:00:00.000Z' };
}

async function mount(entity: EntityLevel, rows: readonly GridRow[], store: MemoryViewStore): Promise<HTMLElement> {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).startsWith('/api/grid/rows')
    ? Response.json({ rows, rowCount: rows.length, truncated: false })
    : Response.json({ error: 'not in this test' }, { status: 404 })));
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push(root);
  act(() => root.render(createElement(GridWorkspace, {
    actor: { userId: '76767676-7676-4676-8676-767676767676', orgId: '77777777-7777-4777-8777-777777777777' },
    entity, currencyCode: 'USD', profileId: 'synthetic-profile', period: { start: '2026-08-01', end: '2026-08-29' },
    comparisonPeriod: { start: '2026-07-03', end: '2026-07-31' }, freshness, campaignId: null, viewStore: store,
  })));
  for (let turn = 0; turn < 6; turn += 1) await act(async () => { await Promise.resolve(); });
  expect(host.querySelector('[data-testid="grid-data-ready"]')?.getAttribute('data-ready')).toBe('true');
  return host;
}

const CODE_SHAPE = /\b(?:[a-z]+_[a-z_]+|[A-Z]+_[A-Z_]+)\b/;
/** No code in the grid's text or in any text-bearing attribute. */
function codesIn(element: Element): string[] {
  const texts = [element.textContent ?? '', ...[...element.querySelectorAll('*')].flatMap((node) =>
    ['title', 'aria-label', 'placeholder'].map((name) => node.getAttribute(name) ?? ''))];
  return texts.flatMap((text) => text.match(CODE_SHAPE) ?? []);
}
const cellText = (row: Element, index: number) => row.querySelectorAll('[role="cell"]')[index]?.textContent ?? '';

describe('targets grid labels (V19, D3, D6)', () => {
  it('reads every match type, expression type and kind in words, with a phrase only where the target has one', async () => {
    const store = new MemoryViewStore();
    await store.rememberLayout(view('targets', ['targeting', 'target_phrase', 'target_kind', 'match_type', 'spend']));
    const rows = [...keywordRows, ...expressionRows];
    const host = await mount('targets', rows, store);
    const grid = host.querySelector('[data-testid="grid-scroller"]')!;
    const bodyRows = [...grid.querySelectorAll('[data-testid="grid-row"]')];
    expect(bodyRows).toHaveLength(rows.length);
    const byId = new Map(bodyRows.map((row) => [row.querySelector('a')?.getAttribute('href')?.match(/targets\/([^?]+)/)?.[1], row]));
    let checked = 0;
    MatchType.options.forEach((matchType, index) => {
      const row = byId.get(`keyword-${index}`)!;
      // Cell 0 is the selection checkbox; then Target, Phrase, Kind, Match.
      expect(cellText(row, 4)).toBe(MATCH_TYPE_LABELS[matchType]);
      expect(cellText(row, 3)).toBe('Keyword');
      expect(cellText(row, 2)).toBe(`synthetic phrase ${index}`);
      expect(row.querySelector('[data-targeting-cell] small')?.textContent).toContain(MATCH_TYPE_LABELS[matchType]);
      checked += 1;
    });
    TARGET_EXPRESSION_TYPES.forEach((type, index) => {
      const row = byId.get(`expression-${index}`)!;
      expect(row.querySelector('[data-targeting-cell] a')?.textContent).not.toContain(type);
      expect(cellText(row, 2)).toBe('—');
      expect(cellText(row, 3)).toMatch(/^(Automatic|Product|Theme|Audience) target$/);
      checked += 1;
    });
    expect(checked).toBe(MatchType.options.length + TARGET_EXPRESSION_TYPES.length);
    expect(codesIn(grid)).toEqual([]);
    expect(grid.textContent).toContain('Many searches');
    expect(grid.textContent).not.toContain('not the query');
  });

  it('reads every placement in words on the Placements grid', async () => {
    const store = new MemoryViewStore();
    const host = await mount('placements', placementRows, store);
    const grid = host.querySelector('[data-testid="grid-scroller"]')!;
    const labels = [...grid.querySelectorAll('[data-testid="grid-row"]')].map((row) => cellText(row, 1));
    expect(labels.sort()).toEqual(Object.values(PLACEMENT_LABELS).sort());
    expect(codesIn(grid)).toEqual([]);
  });

  it('derives the phrase dimension once, for target rows only', () => {
    const scoped = scopeRows([...keywordRows.slice(0, 1), ...expressionRows.slice(0, 1), placementRows[0]!], null);
    expect(scoped.map((row) => row.dimensions['target_phrase'])).toEqual(['synthetic phrase 0', null, undefined]);
    expect(scopeRows(placementRows, null)).toBe(placementRows);
  });
});

describe('selection and widths on the workspace (V4, J4, D2b)', () => {
  it('shows none, some and all on the select-all box and keeps the checkbox column whole', async () => {
    const store = new MemoryViewStore();
    await store.rememberLayout(view('targets', ['targeting', 'spend']));
    const host = await mount('targets', keywordRows.slice(0, 3), store);
    const all = host.querySelector<HTMLInputElement>('input[aria-label="Select all 3 matching rows"]')!;
    expect(all.getAttribute('data-selection-state')).toBe('none');
    const selectionHeader = all.closest<HTMLElement>('[role="columnheader"]')!;
    expect(Number.parseFloat(selectionHeader.style.width)).toBeGreaterThanOrEqual(36);
    expect(selectionHeader.querySelector('[role="separator"]')).toBeNull();
    await act(async () => host.querySelector<HTMLInputElement>('input[aria-label="Select synthetic phrase 1 in Synthetic campaign"]')!.click());
    expect([all.getAttribute('data-selection-state'), all.indeterminate, all.getAttribute('aria-checked')]).toEqual(['some', true, 'mixed']);
    await act(async () => all.click());
    expect([all.getAttribute('data-selection-state'), all.checked, host.textContent?.includes('3 selected')]).toEqual(['all', true, true]);
    await act(async () => all.click());
    expect(all.getAttribute('data-selection-state')).toBe('none');
  });

  it('resizes a column from its visible edge, saves the width in the view and restores it next time', async () => {
    const store = new MemoryViewStore();
    await store.rememberLayout(view('targets', ['targeting', 'spend', 'acos']));
    const host = await mount('targets', keywordRows.slice(0, 2), store);
    const spend = () => host.querySelector<HTMLElement>('[role="columnheader"][aria-label="Spend"]')!;
    const before = Number.parseFloat(spend().style.width);
    const edge = spend().querySelector<HTMLElement>('[role="separator"][aria-label="Resize Spend"]')!;
    await act(async () => {
      edge.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: 300 }));
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 340 }));
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 364 }));
      window.dispatchEvent(new MouseEvent('mouseup'));
    });
    expect(Number.parseFloat(spend().style.width)).toBe(before + 64);
    expect(parseGridView(new URL(window.location.href).searchParams.get('view'))?.widths).toEqual({ spend: before + 64 });
    act(() => { for (const root of mounted.splice(0)) root.unmount(); });
    expect((await store.lastLayout('targets'))?.widths).toEqual({ spend: before + 64 });
    window.history.replaceState(null, '', '/');
    const again = await mount('targets', keywordRows.slice(0, 2), store);
    expect(Number.parseFloat(again.querySelector<HTMLElement>('[role="columnheader"][aria-label="Spend"]')!.style.width)).toBe(before + 64);
    expect(parseGridView(new URL(window.location.href).searchParams.get('view'))?.widths).toEqual({ spend: before + 64 });
  });
});
