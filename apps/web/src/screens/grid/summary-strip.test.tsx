// @vitest-environment jsdom
import { useState } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ENTITY_LEVELS, LocalViewStore, type GridRow, type SavedView } from '@wizard-ads/ui';
import { GRID_SUMMARY_METRICS, GridSavedView, parseGridView, serializeGridView, type GridPerformanceEvidence } from '@wizard-ads/shared';
import { PerformanceSummary } from './performance-chrome';
import { DEFAULT_SUMMARY_METRICS } from './summary-model';
import { formatDateWindow, formatShellDate } from '../../ui/date-format';

const params = vi.hoisted(() => ({ current: new URLSearchParams() }));
vi.mock('next/navigation', () => ({ useSearchParams: () => params.current }));

const BASES = ['impressions', 'clicks', 'spend', 'sales', 'orders', 'units'] as const;
const totals = (spend: number, sales: number) => ({ impressions: 1000, clicks: 20, spend, sales, orders: 2, units: 2 });
const steady: GridRow = { id: 'steady', currencyCode: 'USD', dimensions: {}, totals: totals(10, 40), comparison: totals(8, 20) };
const stopped: GridRow = { id: 'stopped', currencyCode: 'USD', dimensions: {}, totals: totals(0, 0), comparison: totals(5, 10),
  measurement: { missing: [...BASES], comparisonMissing: [], unreported: true } };
const launched: GridRow = { id: 'launched', currencyCode: 'USD', dimensions: {}, totals: totals(6, 0), comparison: null };
const PERIOD = { start: '2026-08-17', end: '2026-09-15' };
const COMPARISON = { start: '2026-07-18', end: '2026-08-16' };
const performance = (held: { heldFrom: string | null; heldThrough: string | null }): GridPerformanceEvidence => ({
  feeds: [], unattributed: null, rankDays: {}, summary: { source: 'sp_target', ...held, period: PERIOD, comparison: COMPARISON },
});
const base: SavedView = { id: 'default', name: 'Default', entity: 'campaigns', columns: [], pinned: [], widths: {}, filter: { groups: [] },
  sort: [], groupBy: [], dateRange: null, updatedAt: '2026-09-24T00:00:00.000Z' };
const strip = () => screen.getByTestId('grid-kpis');
const card = (key: string) => strip().querySelector<HTMLElement>(`[data-summary-metric="${key}"]`)!;
const value = (key: string) => card(key).querySelector('strong')!;

function Harness({ rows, initial = base, evidence }: { rows: readonly GridRow[]; initial?: SavedView; evidence?: GridPerformanceEvidence }) {
  const [view, setView] = useState(initial);
  return <PerformanceSummary rows={rows} view={view} onChange={(patch) => setView((current) => ({ ...current, ...patch }))} currencyCode="USD" profileId="synthetic"
    {...(evidence === undefined ? {} : { performance: evidence })} />;
}

beforeEach(() => { params.current = new URLSearchParams(); });

describe('summary strip states', () => {
  it('measured: every default card totals the rows that reported in each window', () => {
    render(<Harness rows={[steady, stopped, launched]} evidence={performance({ heldFrom: '2026-07-01', heldThrough: '2026-09-15' })} />);
    expect([...strip().querySelectorAll('[data-summary-metric]')].map((node) => node.getAttribute('data-summary-metric'))).toEqual(DEFAULT_SUMMARY_METRICS);
    expect([...strip().querySelectorAll('strong')].map((node) => node.getAttribute('data-summary-state'))).toEqual(Array(8).fill('measured'));
    expect(card('spend').textContent).toBe('Spend$16.00$13.00 · +23.1%');
    expect(card('acos').textContent).toBe('ACOS40.0%43.3% · -7.7%');
    expect(strip().querySelector('[data-summary-reason]')).toBeNull();
  });

  it('explained not measured: the card names the absent source and the date its facts start or end', () => {
    render(<Harness rows={[stopped]} evidence={performance({ heldFrom: '2026-06-01', heldThrough: '2026-08-10' })} />);
    const reason = `Sponsored Products target facts are held only through ${formatShellDate('2026-08-10')}, before this range (${formatDateWindow(PERIOD.start, PERIOD.end)}) starts.`;
    expect(value('spend').textContent).toBe('Not measured');
    expect(value('spend').getAttribute('data-summary-state')).toBe('not-measured');
    const detail = card('spend').querySelector('[data-summary-reason]')!;
    expect(detail.textContent).toBe(reason);
    expect(detail.getAttribute('title')).toBe(reason);
    expect(card('spend').getAttribute('aria-describedby')?.split(' ')).toEqual([value('spend').id, detail.id]);
    // The comparison window is held, and the stopped campaign reported in it.
    expect(strip().querySelectorAll('[data-summary-state="not-measured"]')).toHaveLength(8);
  });

  it('explained not measured in the comparison window only, beside a measured value', () => {
    render(<Harness rows={[launched]} evidence={performance({ heldFrom: '2026-08-20', heldThrough: '2026-09-15' })} />);
    expect(value('spend').textContent).toBe('$6.00');
    expect(value('spend').getAttribute('title')).toBe(`Sponsored Products target facts are held from ${formatShellDate('2026-08-20')}, so this range (${formatDateWindow(PERIOD.start, PERIOD.end)}) is only partly covered.`);
    const detail = value('spend').nextElementSibling!;
    expect(detail.textContent).toBe('Not measured · —');
    expect(detail.getAttribute('title')).toBe(`Sponsored Products target facts are held from ${formatShellDate('2026-08-20')}, after the comparison range (${formatDateWindow(COMPARISON.start, COMPARISON.end)}) ends.`);
  });

  it('unknown, not unmeasured: a base some reported rows lack shows a dash and its count', () => {
    render(<Harness rows={[steady, { ...launched, measurement: { missing: ['sales'], comparisonMissing: [] } }]} />);
    expect(value('sales').textContent).toBe('—');
    expect(value('sales').getAttribute('data-summary-state')).toBe('unknown');
    expect(card('sales').querySelector('[data-summary-reason]')?.textContent).toBe('Sales is missing for 1 of 2 campaigns with facts in this range, so no total is shown.');
    expect(value('spend').textContent).toBe('$16.00');
  });

  it('a switched-off comparison says so instead of guessing', () => {
    params.current = new URLSearchParams({ comparison: 'none' });
    render(<Harness rows={[{ ...steady, comparison: null }]} />);
    const detail = value('spend').nextElementSibling!;
    expect(detail.textContent).toBe('— · —');
    expect(detail.getAttribute('title')).toBe('Comparison is off.');
  });

  it('customized set: shows the saved metrics in order; only the eight chartable ones toggle series', () => {
    render(<Harness rows={[steady]} initial={{ ...base, summary: { metrics: ['roas', 'spend', 'units'] } }} />);
    expect([...strip().querySelectorAll('[data-summary-metric]')].map((node) => node.getAttribute('data-summary-metric'))).toEqual(['roas', 'spend', 'units']);
    expect(within(strip()).getAllByRole('button', { name: /^Chart / }).map((node) => node.getAttribute('aria-label'))).toEqual(['Chart spend']);
    expect(within(strip()).getByRole('group', { name: 'ROAS summary' }).querySelector('strong')?.textContent).toBe('4.00');
    expect(within(strip()).getByRole('group', { name: 'Units summary' }).querySelector('strong')?.textContent).toBe('2');
  });

  it('without chart: no preset draws a trend chart, because neither performance frame has one', () => {
    for (const entity of ENTITY_LEVELS) {
      const { container, unmount } = render(<Harness rows={[steady]} initial={{ ...base, entity }} />);
      expect(container.querySelector('svg'), entity).toBeNull();
      expect(within(container).queryByRole('img'), entity).toBeNull();
      expect(within(strip()).getByTestId('grid-summary-picker-trigger').textContent).toBe('+ Series2 of 4');
      unmount();
    }
  });
});

describe('summary metric picker', () => {
  it('bounds the choice to eight catalogue metrics, keeps one, prunes charted series and resets to the default', () => {
    render(<Harness rows={[steady]} />);
    const trigger = within(strip()).getByTestId('grid-summary-picker-trigger');
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Summary metrics' });
    const boxes = within(dialog).getAllByRole('checkbox');
    expect(boxes).toHaveLength(GRID_SUMMARY_METRICS.length);
    expect(within(dialog).getByRole('status').textContent).toBe("8 of 8 shown. Click a default metric's card to chart it, up to four.");
    // Full: every unchosen metric is disabled until one is removed.
    expect(boxes.filter((box) => (box as HTMLInputElement).disabled).map((box) => box.parentElement!.textContent)).toEqual(['Units', 'CTR', 'CPM', 'CPA', 'RPC', 'AOV', 'ROAS']);
    expect(within(dialog).getByRole('button', { name: 'Reset to default' })).toHaveProperty('disabled', true);
    expect(document.activeElement).toBe(within(dialog).getByRole('checkbox', { name: 'Impressions' }));
    const spendBox = within(dialog).getByRole('checkbox', { name: 'Spend' });
    spendBox.focus();
    fireEvent.click(spendBox);
    // Toggling keeps keyboard focus where the operator is.
    expect(document.activeElement).toBe(spendBox);
    expect(strip().querySelector('[data-summary-metric="spend"]')).toBeNull();
    expect(trigger.textContent).toBe('+ Series1 of 4');
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'ROAS' }));
    expect([...strip().querySelectorAll('[data-summary-metric]')].map((node) => node.getAttribute('data-summary-metric')))
      .toEqual(['impressions', 'clicks', 'sales', 'orders', 'acos', 'cvr', 'cpc', 'roas']);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reset to default' }));
    expect([...strip().querySelectorAll('[data-summary-metric]')].map((node) => node.getAttribute('data-summary-metric'))).toEqual(DEFAULT_SUMMARY_METRICS);
    act(() => { fireEvent.keyDown(dialog, { key: 'Escape' }); });
    expect(screen.queryByRole('dialog', { name: 'Summary metrics' })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('never removes the last metric', () => {
    render(<Harness rows={[steady]} initial={{ ...base, summary: { metrics: ['spend'] } }} />);
    fireEvent.click(within(strip()).getByTestId('grid-summary-picker-trigger'));
    const dialog = screen.getByRole('dialog', { name: 'Summary metrics' });
    expect(within(dialog).getByRole('checkbox', { name: 'Spend' })).toHaveProperty('disabled', true);
    expect(within(dialog).getAllByRole('checkbox').filter((box) => (box as HTMLInputElement).disabled)).toHaveLength(1);
  });

  it('persists the choice in the saved view and restores it from the shared link and the browser layout', async () => {
    const chosen: SavedView = { ...base, summary: { metrics: ['roas', 'spend', 'acos'] }, chart: { series: ['spend'] } };
    const restored = parseGridView(serializeGridView(chosen));
    expect(restored).toEqual(chosen);
    const memory = new Map<string, string>();
    const store = new LocalViewStore({ getItem: (key) => memory.get(key) ?? null, setItem: (key, item) => { memory.set(key, item); } },
      { orgId: '00000000-0000-4000-8000-000000000321', userId: '00000000-0000-4000-8000-000000000322' });
    await store.rememberLayout(restored!);
    const cached = store.cachedLayout('campaigns');
    expect(cached?.summary).toEqual({ metrics: ['roas', 'spend', 'acos'] });
    render(<Harness rows={[steady]} initial={cached!} />);
    expect([...strip().querySelectorAll('[data-summary-metric]')].map((node) => node.getAttribute('data-summary-metric'))).toEqual(['roas', 'spend', 'acos']);
    expect(within(strip()).getByRole('button', { name: 'Chart spend' }).getAttribute('aria-pressed')).toBe('true');
    // Out-of-bounds documents never restore.
    for (const metrics of [[], [...GRID_SUMMARY_METRICS.slice(0, 9)], ['spend', 'spend'], ['tacos']]) {
      expect(GridSavedView.safeParse({ ...chosen, summary: { metrics } }).success, JSON.stringify(metrics)).toBe(false);
    }
  });
});
