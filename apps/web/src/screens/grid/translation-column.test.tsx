// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TargetTranslation } from '@wizard-ads/shared';
import type { GridRow } from '@wizard-ads/ui';
import { TranslationFailureNotice, useTranslationColumn } from './translation-column';
import { TARGET_EXPRESSION_TYPES } from '@wizard-ads/shared';
import StatusScreen from '../translation-status/view';
import { MemoryViewStore, columnsFor, type FreshnessAssessment } from '@wizard-ads/ui';
import { GridWorkspace } from '../../../app/grid/grid-client';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), useSearchParams: () => new URLSearchParams(window.location.search) }));
// jsdom has no layout; give the virtualized grid one viewport, as grid-tables.test.tsx does.
class StubResizeObserver { observe(): void {} unobserve(): void {} disconnect(): void {} }
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = StubResizeObserver;
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 4000 });
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 4000 });
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const waiting: TargetTranslation = { id: uuid(1), orgId: uuid(2), profileId: uuid(3), originalText: 'Synthetic original', language: 'en', providerId: 'not-configured', result: { status: 'waiting', text: null, reason: null }, provenance: { requestId: uuid(4), requestedBy: uuid(5), requestedAt: '2026-09-14T00:00:00Z', completedAt: null } };
const terminal: TargetTranslation = { ...waiting, result: { status: 'unavailable', text: null, reason: 'provider not configured' }, provenance: { ...waiting.provenance, completedAt: '2026-09-14T00:00:01Z' } };
const rows: GridRow[] = [{ id: 'target:one', dimensions: { targeting: waiting.originalText }, currencyCode: 'USD', totals: { spend: 1, sales: 2, clicks: 1, impressions: 10, orders: 1, units: 1 }, comparison: null }];
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(() => { act(() => { for (const root of roots.splice(0)) root.unmount(); }); document.body.replaceChildren(); vi.unstubAllGlobals(); });
function Column({ profile = waiting.profileId }: { profile?: string }) {
  const translation = useTranslationColumn(profile, 'en', true, rows);
  return <><button onClick={translation.refresh}>Refresh translations</button>{translation.cell(rows[0]!)}</>;
}
async function mount(view: ReturnType<typeof createElement>) {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); roots.push(root);
  await act(async () => { root.render(view); });
  return { host, root };
}
describe('translation status refresh', () => {
  it('refreshes a queued column attempt to the worker terminal result without re-enqueueing', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ rows: [], count: 0 }))
      .mockResolvedValueOnce(Response.json({ row: waiting, count: 1 }))
      .mockResolvedValueOnce(Response.json({ rows: [terminal], count: 1 }));
    vi.stubGlobal('fetch', fetch);
    const { host } = await mount(createElement(Column));
    expect(host.textContent).toContain('Translating…');
    await act(async () => host.querySelector('button')!.click());
    expect(host.textContent).toContain('Translation unavailable');
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(1);
  });
  it('cancels the old column scope and rejects its late response', async () => {
    let finish!: (response: Response) => void;
    const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce(Response.json({ rows: [{ ...terminal, profileId: uuid(6) }], count: 1 }));
    vi.stubGlobal('fetch', fetch);
    const { host, root } = await mount(createElement(Column));
    const signal = fetch.mock.calls[0]![1].signal as AbortSignal;
    await act(async () => root.render(createElement(Column, { profile: uuid(6) })));
    expect(signal.aborted).toBe(true);
    await act(async () => finish(Response.json({ rows: [waiting], count: 1 })));
    expect(host.textContent).toContain('Translation unavailable');
    expect(host.textContent).not.toContain('Translating…');
  });
  it('refreshes the status screen after Retry completes and sends the expected prior attempt', async () => {
    const next = { ...waiting, provenance: { ...waiting.provenance, requestId: uuid(7) } };
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ row: next, count: 1 }))
      .mockResolvedValueOnce(Response.json({ rows: [{ ...terminal, provenance: { ...terminal.provenance, requestId: uuid(7) } }], count: 1 }));
    vi.stubGlobal('fetch', fetch);
    const { host } = await mount(createElement(StatusScreen, { data: { view: 'ready', profileId: waiting.profileId, language: 'en', canRetry: true, rows: [terminal] } }));
    await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Retry')!.click());
    expect(host.textContent).toContain('Waiting');
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ profileId: waiting.profileId, translationId: waiting.id, expectedRequestId: waiting.provenance.requestId });
    await act(async () => [...host.querySelectorAll('button')].find((button) => button.textContent === 'Refresh translations')!.click());
    expect(host.textContent).toContain('Translation unavailable');
    expect(host.textContent).not.toContain('Waiting');
  });
});

function Cells({ columnRows }: { columnRows: GridRow[] }) {
  const translation = useTranslationColumn(waiting.profileId, 'en', true, columnRows);
  return <><TranslationFailureNotice failure={translation.failure} /><ul>{columnRows.map((row) => <li key={row.id} data-row={row.id}>{translation.cell(row)}</li>)}</ul></>;
}
const gridRow = (id: string, dimensions: GridRow['dimensions']): GridRow => ({ ...rows[0]!, id, dimensions });
const cellOf = (host: HTMLElement, id: string) => host.querySelector<HTMLElement>(`[data-row="${id}"] > span`)!;
const posted = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.filter((call) => call[1]?.method === 'POST').map((call) => JSON.parse(call[1].body).originalText as string);

describe('translation cell states', () => {
  it('shows a visible pending state while a translation is queued, never a blank cell', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ rows: [waiting], count: 1 }));
    vi.stubGlobal('fetch', fetch);
    const { host } = await mount(createElement(Cells, { columnRows: rows }));
    const cell = cellOf(host, 'target:one');
    expect(cell.getAttribute('data-translation-state')).toBe('pending');
    expect(cell.textContent).toBe('Translating…');
    expect(cell.getAttribute('aria-busy')).toBe('true');
    expect(host.querySelector('[data-testid="translation-failure"]')).toBeNull();
    expect(posted(fetch)).toHaveLength(0);
  });
  it('shows the translated text once available', async () => {
    const available: TargetTranslation = { ...terminal, result: { status: 'available', text: 'Synthetic translated wording', reason: null } };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ rows: [available], count: 1 })));
    const { host } = await mount(createElement(Cells, { columnRows: rows }));
    const cell = cellOf(host, 'target:one');
    expect(cell.getAttribute('data-translation-state')).toBe('translated');
    expect(cell.textContent).toBe('Synthetic translated wording');
  });
  it('shows a failed translation in the cell and once in the notice', async () => {
    const second = gridRow('target:two', { targeting: 'Synthetic second original', target_kind: 'keyword', match_type: 'exact' });
    const secondFailed: TargetTranslation = { ...terminal, id: uuid(8), originalText: 'Synthetic second original' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ rows: [terminal, secondFailed], count: 2 })));
    const { host } = await mount(createElement(Cells, { columnRows: [rows[0]!, second] }));
    for (const id of ['target:one', 'target:two']) {
      expect(cellOf(host, id).getAttribute('data-translation-state')).toBe('failed');
      expect(cellOf(host, id).textContent).toBe('Translation unavailable: provider not configured');
    }
    const notices = host.querySelectorAll('[data-testid="translation-failure"]');
    expect(notices).toHaveLength(1);
    expect(notices[0]!.getAttribute('role')).toBe('alert');
    expect(notices[0]!.textContent).toBe('2 translations unavailable: provider not configured');
  });
  it('shows a status load failure in every waiting cell and once in the notice', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 })));
    const { host } = await mount(createElement(Cells, { columnRows: rows }));
    expect(cellOf(host, 'target:one').getAttribute('data-translation-state')).toBe('failed');
    expect(cellOf(host, 'target:one').textContent).toBe('Translation unavailable: Translation status could not be loaded');
    expect(host.querySelectorAll('[data-testid="translation-failure"]')).toHaveLength(1);
    expect(host.querySelector('[data-testid="translation-failure"]')!.textContent).toBe('Translations stopped: Translation status could not be loaded');
  });
});

describe('translation scope', () => {
  it('queues keyword phrases only and never shows a non-keyword as translated, across every target kind', async () => {
    const keywords = [
      gridRow('kw:exact', { targeting: 'synthetic trail shoes', target_kind: 'keyword', match_type: 'exact' }),
      gridRow('kw:word', { targeting: 'complements', target_kind: 'keyword', match_type: 'broad' }),
      gridRow('st:keyword', { search_term: 'synthetic query', targeting: 'synthetic running socks', match_type: 'phrase' }),
      gridRow('kw:negative', { targeting: 'synthetic cheap socks', target_kind: 'keyword', match_type: 'negative_exact' }),
      ...['iPhone', 'airPods', 'Brand', 'USB_C', 'co_sleeper', '1080'].map((text) => gridRow(`kw:${text}`, { targeting: text, target_id: `synthetic-target-${text}`, target_kind: 'keyword', match_type: 'exact' })),
      gridRow('kw:upper-kind', { targeting: 'co-sleeper', target_kind: 'KEYWORD', match_type: 'phrase' }),
    ];
    expect(keywords).toHaveLength(11);
    const nonKeywords = [
      ...TARGET_EXPRESSION_TYPES.map((code) => gridRow(`code:${code}`, { targeting: code, target_kind: 'target', match_type: null })),
      ...TARGET_EXPRESSION_TYPES.map((code) => gridRow(`bare:${code}`, { search_term: 'synthetic query', targeting: code, match_type: null })),
      gridRow('pt:asin', { targeting: 'asin="B000SYN267"', target_kind: 'target', match_type: 'asin_same_as' }),
      gridRow('pt:category', { targeting: 'category="000000001" price>10', target_kind: 'product target', match_type: null }),
      gridRow('pt:words', { targeting: 'synthetic product words', target_kind: 'target', match_type: null }),
      gridRow('auto:close', { targeting: 'close-match', target_kind: 'target', match_type: 'close_match' }),
      gridRow('st:auto', { search_term: 'synthetic query', targeting: 'loose-match', match_type: 'TARGETING_EXPRESSION_PREDEFINED' }),
      gridRow('st:asin', { search_term: 'b000syn269', targeting: 'B000SYN269', match_type: null }),
      gridRow('match:asin', { targeting: 'synthetic words', match_type: 'asin_same_as' }),
      gridRow('id:fallback', { targeting: '123456789012', target_id: '123456789012', target_kind: 'keyword', match_type: 'exact' }),
      gridRow('campaign', { campaign_name: 'Synthetic campaign name', campaign_id: '000000000001' }),
      gridRow('uuid', { targeting: '00000000-0000-4000-8000-000000000001', target_kind: 'keyword', match_type: 'exact' }),
      gridRow('kw:asin', { targeting: 'B000SYN270', target_kind: 'keyword', match_type: 'exact' }),
      gridRow('st:quoted', { search_term: 'synthetic query', targeting: 'asin="B000SYN271"', match_type: 'exact' }),
      gridRow('st:code', { search_term: 'synthetic query', targeting: 'QUERY_HIGH_REL_MATCHES', match_type: 'broad' }),
    ];
    expect(nonKeywords).toHaveLength(2 * TARGET_EXPRESSION_TYPES.length + 13);
    // The status endpoint already holds "translations" for non-keyword texts; none may be shown.
    const stale = nonKeywords.flatMap((row) => typeof row.dimensions['targeting'] === 'string'
      ? [{ ...terminal, id: uuid(100 + nonKeywords.indexOf(row)), originalText: row.dimensions['targeting'], result: { status: 'available' as const, text: 'invented translation', reason: null } }] : []);
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ rows: stale, count: stale.length }));
    for (const row of keywords) fetch.mockResolvedValueOnce(Response.json({ row: { ...waiting, id: uuid(200 + keywords.indexOf(row)), originalText: row.dimensions['targeting'] }, count: 1 }));
    vi.stubGlobal('fetch', fetch);
    const { host } = await mount(createElement(Cells, { columnRows: [...keywords, ...nonKeywords] }));
    expect(posted(fetch)).toEqual(['synthetic trail shoes', 'complements', 'synthetic running socks', 'synthetic cheap socks', 'iPhone', 'airPods', 'Brand', 'USB_C', 'co_sleeper', '1080', 'co-sleeper']);
    expect(fetch).toHaveBeenCalledTimes(1 + keywords.length);
    for (const row of keywords) expect(cellOf(host, row.id).getAttribute('data-translation-state'), row.id).toBe('pending');
    for (const row of nonKeywords) {
      expect(cellOf(host, row.id).getAttribute('data-translation-state'), row.id).toBe('not-keyword');
      expect(cellOf(host, row.id).textContent, row.id).toBe('Keywords only');
    }
    expect(host.textContent).not.toContain('invented translation');
  });
});

describe('translation failure banner on the grid workspace', () => {
  const freshness: FreshnessAssessment = { tone: 'good', headline: 'Fresh', details: [], staleTypes: [], lossyTypes: [], coversThrough: '2026-08-29' };
  const targetRows: GridRow[] = ['synthetic trail shoes', 'synthetic running socks'].map((targeting, index) => ({ ...rows[0]!, id: `target:kw-${index}`,
    dimensions: { target_id: `kw-${index}`, targeting, target_kind: 'keyword', match_type: 'exact', target_state: 'enabled', campaign_name: 'Synthetic campaign' } }));
  async function workspace(translationStatus: () => Response) {
    const store = new MemoryViewStore();
    await store.rememberLayout({ id: 'default', name: 'Default', entity: 'targets', columns: ['targeting', 'translation', 'spend'], pinned: [columnsFor('targets').find((column) => column.pinned)!.id],
      widths: {}, filter: { groups: [] }, sort: [], groupBy: [], dateRange: null, updatedAt: '2026-08-29T00:00:00.000Z', translation: { language: 'en' } });
    const fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/grid/rows')) return Response.json({ rows: targetRows, rowCount: targetRows.length, truncated: false });
      if (url.startsWith('/api/translation?')) return translationStatus();
      return Response.json({ error: 'not in this test' }, { status: 404 });
    });
    vi.stubGlobal('fetch', fetch);
    const { host } = await mount(createElement(GridWorkspace, {
      actor: { userId: '76767676-7676-4676-8676-767676767676', orgId: '77777777-7777-4777-8777-777777777777' },
      entity: 'targets', currencyCode: 'USD', profileId: waiting.profileId, period: { start: '2026-08-01', end: '2026-08-29' },
      comparisonPeriod: { start: '2026-07-03', end: '2026-07-31' }, freshness, campaignId: null, viewStore: store,
    }));
    for (let turn = 0; turn < 8; turn += 1) await act(async () => { await Promise.resolve(); });
    expect(host.querySelector('[data-testid="grid-data-ready"]')?.getAttribute('data-ready')).toBe('true');
    const toolbar = host.querySelector<HTMLElement>('[data-testid="grid-toolbar-readiness"]')!;
    expect([...toolbar.querySelectorAll('a')].filter((link) => link.textContent === 'Translation status')).toHaveLength(1);
    return { host, toolbar, fetch };
  }
  it('shows the failure summary once, beside the Translation status link, when the status read fails', async () => {
    const { host, toolbar, fetch } = await workspace(() => new Response(null, { status: 503 }));
    const banners = host.querySelectorAll('[data-testid="translation-failure"]');
    expect(banners).toHaveLength(1);
    expect(toolbar.contains(banners[0]!)).toBe(true);
    expect(banners[0]!.getAttribute('role')).toBe('alert');
    expect(banners[0]!.textContent).toBe('Translations stopped: Translation status could not be loaded');
    expect(fetch.mock.calls.filter((call) => call[1]?.method === 'POST')).toHaveLength(0);
  });
  it('shows no banner when every translation is available', async () => {
    const available = targetRows.map((row, index): TargetTranslation => ({ ...terminal, id: uuid(300 + index), originalText: row.dimensions['targeting'] as string,
      result: { status: 'available', text: `synthetic translation ${index}`, reason: null } }));
    const { host } = await workspace(() => Response.json({ rows: available, count: available.length }));
    expect(host.querySelectorAll('[data-testid="translation-failure"]')).toHaveLength(0);
    expect(host.textContent).toContain('synthetic translation 0');
  });
});
