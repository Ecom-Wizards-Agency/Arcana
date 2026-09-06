// @vitest-environment jsdom
/**
 * The optimizer campaign table, now rendered through the Data Grid.
 *
 * jsdom has no layout engine, so the virtualizer is handed one viewport-sized
 * box through the component's `initialGridRect` seam and everything downstream
 * is the production component. `scrollTo`, `scrollHeight` and `ResizeObserver`
 * are stubbed for the same reason they are in `packages/ui`: without them a
 * scroll can never move the virtual window, which is the gesture that replaced
 * pagination and therefore the thing most worth asserting.
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OptimizerCampaignRow } from '../../src/optimizer/campaigns';
import { CampaignWorkspace, toOptimizerGridRows } from './campaign-workspace';

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

const navigation = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => navigation }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: Array<{ unmount: () => void }> = [];

function row(index: number, overrides: Partial<OptimizerCampaignRow> = {}): OptimizerCampaignRow {
  const suffix = String(index).padStart(2, '0');
  return {
    adProduct: 'SP',
    biddingStrategy: 'dynamic_bids_down_only',
    campaignId: `campaign-${suffix}`,
    clicks: index,
    comparisonRows: 1,
    comparisonSpend: index - 1,
    currentRows: 1,
    dailyBudget: 20,
    eligibilityReason: null,
    groupId: null,
    groupName: null,
    groupRole: null,
    impressions: index * 10,
    lastRunAt: null,
    name: `Synthetic campaign ${suffix}`,
    orders: 1,
    proposals: 0,
    sales: index * 2,
    spend: index,
    startDate: '2026-01-01',
    state: 'enabled',
    selectable: true,
    ...overrides,
  };
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter === undefined) throw new Error('input value setter is unavailable');
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function setSelectValue(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  if (setter === undefined) throw new Error('select value setter is unavailable');
  setter.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

function gridRows(host: HTMLElement): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>('[data-testid="grid-row"]')];
}

function rowNames(host: HTMLElement): string[] {
  return gridRows(host).map((element) => {
    const link = element.querySelector('.wa-optimizer-campaigns__name');
    return link?.textContent ?? '';
  });
}

function header(host: HTMLElement, label: string): HTMLElement {
  const element = host.querySelector<HTMLElement>(`[role="columnheader"][aria-label="${label}"]`);
  if (element === null) throw new Error(`no column header labelled '${label}'`);
  return element;
}

function scrollGrid(host: HTMLElement, top: number): void {
  const scroller = host.querySelector<HTMLElement>('[data-testid="grid-scroller"]');
  if (scroller === null) throw new Error('the grid has no scroller');
  act(() => {
    scroller.scrollTop = top;
    scroller.dispatchEvent(new Event('scroll'));
  });
}

function footerText(host: HTMLElement): string {
  return host.querySelector('[data-testid="grid-shell"]')?.lastElementChild?.textContent ?? '';
}

afterEach(() => {
  act(() => {
    for (const root of mounted.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  navigation.refresh.mockReset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (document as unknown as Record<string, unknown>)['visibilityState'];
});

function workspaceProps(
  rows: readonly OptimizerCampaignRow[],
  overrides: Partial<Parameters<typeof CampaignWorkspace>[0]> = {},
): Parameters<typeof CampaignWorkspace>[0] {
  return {
    currencyCode: 'USD',
    initialBatchId: null,
    initialGridRect: VIEWPORT,
    mayRunOptimizer: true,
    previewReady: true,
    period: { start: '2026-08-01', end: '2026-08-30' },
    profileId: '00000000-0000-4000-8000-000000000001',
    rows,
    run: null,
    ...overrides,
  };
}

function mount(
  rows: readonly OptimizerCampaignRow[],
  overrides: Partial<Parameters<typeof CampaignWorkspace>[0]> = {},
): { host: HTMLElement; root: ReturnType<typeof createRoot> } {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push(root);
  act(() => root.render(createElement(CampaignWorkspace, workspaceProps(rows, overrides))));
  return { host, root };
}

describe('campaign optimizer workspace', () => {
  it('renders every campaign in one continuous scroll with no pagination control', () => {
    const { host } = mount(Array.from({ length: 56 }, (_, index) => row(index + 1)));

    // No page slice and no pager: the grid holds the whole set and the DOM
    // holds one viewport of it.
    expect(host.textContent).not.toContain('Page 1 of');
    expect([...host.querySelectorAll('button')].map((button) => button.textContent?.trim()))
      .not.toContain('Next →');
    expect(footerText(host)).toContain('56 of 56 rows');
    expect(host.querySelector('.wa-optimizer-campaigns__shown')?.textContent).toBe('56 campaigns');

    // Spend descending is the default order, so campaign 56 leads and the DOM
    // carries a viewport, not fifty-six rows.
    const rendered = gridRows(host);
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(56);
    expect(rowNames(host)[0]).toBe('Synthetic campaign 56');
    expect(host.textContent).not.toContain('Synthetic campaign 01');

    // Scrolling — not a Next button — reaches the far end of the set.
    scrollGrid(host, 56 * 42);
    expect(rowNames(host)).toContain('Synthetic campaign 01');
    expect(host.textContent).not.toContain('Synthetic campaign 56');
  });

  it('sorts on a header click, adds a second key with shift-click, and offers no ordering on control headers', () => {
    const { host } = mount(Array.from({ length: 12 }, (_, index) => row(index + 1)));
    const spend = header(host, 'Spend');
    expect(spend.getAttribute('aria-sort')).toBe('descending');
    expect(rowNames(host)[0]).toBe('Synthetic campaign 12');

    act(() => spend.click());
    expect(spend.getAttribute('aria-sort')).toBe('ascending');
    expect(rowNames(host)[0]).toBe('Synthetic campaign 01');

    // Shift-click appends rather than replacing: campaign stays ascending and
    // orders becomes the second key.
    const orders = header(host, 'Orders');
    act(() => orders.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })));
    expect(spend.getAttribute('aria-sort')).toBe('ascending');
    expect(orders.getAttribute('aria-sort')).toBe('descending');

    // The selection and recommendation columns hold a gesture, not a value.
    for (const label of ['Select', 'Recommendation']) {
      const control = header(host, label);
      expect(control.getAttribute('aria-sort')).toBeNull();
      expect(control.getAttribute('tabindex')).toBeNull();
      act(() => control.click());
      expect(spend.getAttribute('aria-sort')).toBe('ascending');
    }
  });

  it('groups on a dimension and nests a second level with ratios recomputed from sums', () => {
    const rows = Array.from({ length: 12 }, (_, index) => {
      const position = index + 1;
      return row(position, {
        state: position <= 8 ? 'enabled' : 'paused',
        adProduct: position % 2 === 0 ? 'SP' : 'SB',
        spend: 10,
        sales: 40,
      });
    });
    const { host } = mount(rows);
    const addLevel = host.querySelector<HTMLSelectElement>('select[aria-label="Add grouping level"]');
    expect(addLevel).not.toBeNull();
    if (addLevel === null) throw new Error('the group bar has no keyboard path');

    act(() => setSelectValue(addLevel, 'campaign_state'));
    const tree = host.querySelector('[role="treegrid"]');
    expect(tree?.getAttribute('aria-label')).toBe('Results grouped by campaign_state');
    expect(host.querySelectorAll('[data-testid="grid-group-chip"]')).toHaveLength(1);
    // Two states, each an aggregate of its members: 8 × $10 against 8 × $40.
    expect(host.querySelectorAll('[role="row"][aria-level="1"]')).toHaveLength(2);
    // A group row is an aggregate, so it carries no campaign link to click.
    expect(rowNames(host).every((name) => name === '')).toBe(true);
    expect(host.textContent).toContain('8 rows');

    act(() => setSelectValue(addLevel, 'ad_product'));
    expect(host.querySelector('[role="treegrid"]')?.getAttribute('aria-label'))
      .toBe('Results grouped by campaign_state, ad_product');
    expect(host.querySelectorAll('[data-testid="grid-group-chip"]')).toHaveLength(2);
    expect(host.querySelectorAll('[role="row"][aria-level="2"]').length).toBeGreaterThan(0);
    // 25% at every level, because it is spend/sales at that level and never an
    // average of the members' own ratios.
    expect(host.textContent).toContain('25.0%');
  });

  it('narrows on the group, state and clear-filter controls without touching the whole set', () => {
    const rows = Array.from({ length: 56 }, (_, index) => {
      const position = index + 1;
      return row(position, {
        groupId: position <= 30 ? 'group-a' : null,
        groupName: position <= 30 ? 'Synthetic group' : null,
        groupRole: position <= 30 ? 'profit' : null,
        state: position <= 40 ? 'enabled' : 'paused',
      });
    });
    const { host } = mount(rows);
    const shown = () => host.querySelector('.wa-optimizer-campaigns__shown')?.textContent;
    expect(shown()).toBe('56 campaigns');

    const selects = host.querySelectorAll<HTMLSelectElement>('select');
    const group = selects.item(0);
    const state = selects.item(1);
    act(() => setSelectValue(group, 'group-a'));
    expect(shown()).toBe('30 of 56 campaigns');
    expect(footerText(host)).toContain('30 of 30 rows');

    act(() => setSelectValue(state, 'paused'));
    expect(shown()).toBe('0 of 56 campaigns');
    expect(host.textContent).toContain('No campaigns match these filters.');

    const clear = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Clear filters');
    expect(clear).toBeDefined();
    act(() => clear?.click());
    expect(shown()).toBe('56 campaigns');

    const search = host.querySelector<HTMLInputElement>('input[aria-label="Find campaign"]');
    act(() => {
      if (search !== null) setInputValue(search, 'campaign 56');
    });
    expect(shown()).toBe('1 of 56 campaigns');
    expect(rowNames(host)).toEqual(['Synthetic campaign 56']);
  });

  it('selects every filtered eligible campaign, retains hidden choices across a filter, and clears globally', () => {
    const rows = Array.from({ length: 56 }, (_, index) => {
      const position = index + 1;
      return row(position, {
        ...(position <= 30
          ? { groupId: 'group-a', groupName: 'Synthetic group', groupRole: 'profit' }
          : {}),
        ...(position === 5
          ? { eligibilityReason: 'Campaign state is paused.', selectable: false, state: 'paused' }
          : {}),
      });
    });
    const { host } = mount(rows);
    const group = host.querySelectorAll<HTMLSelectElement>('select').item(0);
    act(() => setSelectValue(group, 'group-a'));

    const filteredHeader = host.querySelector<HTMLInputElement>('[data-testid="optimizer-select-filtered"]');
    expect(filteredHeader?.getAttribute('aria-label')).toBe('Select all 29 eligible campaigns matching current filters');
    expect(filteredHeader?.indeterminate).toBe(false);
    act(() => filteredHeader?.click());
    expect(filteredHeader?.checked).toBe(true);
    expect(host.querySelector('[data-testid="optimizer-selection-count"]')?.textContent)
      .toContain('29 campaigns selected');

    // The header owned all twenty-nine filtered eligible campaigns, not the
    // rows that happened to be rendered: scrolling finds them already checked.
    scrollGrid(host, 30 * 42);
    const rendered = [...host.querySelectorAll<HTMLInputElement>('[data-testid="optimizer-campaign-select"]')];
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.every((checkbox) => checkbox.checked || checkbox.disabled)).toBe(true);

    // Widening the filter keeps every hidden choice; the header reports the
    // partial state of its new, larger population.
    act(() => setSelectValue(group, 'all'));
    expect(host.querySelector('[data-testid="optimizer-select-filtered"]')?.getAttribute('aria-label'))
      .toBe('Select all 55 eligible campaigns matching current filters');
    const wideHeader = host.querySelector<HTMLInputElement>('[data-testid="optimizer-select-filtered"]');
    expect(wideHeader?.checked).toBe(false);
    expect(wideHeader?.indeterminate).toBe(true);

    act(() => setSelectValue(group, 'unassigned'));
    const firstUnassigned = host.querySelector<HTMLInputElement>('[data-testid="optimizer-campaign-select"]');
    act(() => firstUnassigned?.click());
    expect(host.querySelector('[data-testid="optimizer-selection-count"]')?.textContent)
      .toContain('30 campaigns selected');

    const clear = [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.trim() === 'Clear selected');
    act(() => clear?.click());
    expect(host.querySelector('[data-testid="optimizer-selection-count"]')?.textContent)
      .toContain('No campaigns selected');
    expect(host.querySelector<HTMLInputElement>('[data-testid="optimizer-campaign-select"]')?.checked)
      .toBe(false);
  });

  it('refuses the grid keyboard a selection an ineligible campaign could never have', () => {
    const rows = [
      row(1),
      row(2, {
        eligibilityReason: 'Only Sponsored Products campaigns support bid previews.',
        selectable: false,
        adProduct: 'SB',
      }),
    ];
    const { host } = mount(rows);
    const ineligible = gridRows(host).find((element) => element.textContent?.includes('Synthetic campaign 02'));
    expect(ineligible).toBeDefined();
    act(() => ineligible?.focus());
    act(() => { ineligible?.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })); });
    expect(host.querySelector('[data-testid="optimizer-selection-count"]')?.textContent)
      .toContain('No campaigns selected');

    const eligible = gridRows(host).find((element) => element.textContent?.includes('Synthetic campaign 01'));
    expect(eligible).toBeDefined();
    act(() => eligible?.focus());
    act(() => { eligible?.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })); });
    expect(host.querySelector('[data-testid="optimizer-selection-count"]')?.textContent)
      .toContain('1 campaign selected');
  });

  it('builds grid rows from base sums only, with no invented comparison figures', () => {
    const built = toOptimizerGridRows(
      [row(4, { spend: 30, sales: 120, comparisonRows: 1, comparisonSpend: 20 })],
      'USD',
    );
    expect(built).toHaveLength(1);
    const only = built[0];
    expect(only?.comparison).toBeNull();
    expect(only?.totals).toEqual({ impressions: 40, clicks: 4, spend: 30, sales: 120, orders: 1, units: 0 });
    expect(only?.dimensions['spend_change']).toBeCloseTo(0.5, 10);
    expect(toOptimizerGridRows([row(4, { comparisonRows: 0 })], 'USD')[0]?.dimensions['spend_change'])
      .toBeNull();
  });

  it('retains selection through period refresh and resets it only when the profile changes', () => {
    const rows = [row(1), row(2)];
    const { host, root } = mount(rows);
    const first = host.querySelector<HTMLInputElement>('[data-testid="optimizer-campaign-select"]');
    act(() => first?.click());
    expect(host.textContent).toContain('1 campaign selected');

    act(() => root.render(createElement(CampaignWorkspace, workspaceProps(rows, {
      period: { start: '2026-08-02', end: '2026-08-31' },
    }))));
    expect(host.textContent).toContain('1 campaign selected');

    act(() => root.render(createElement(CampaignWorkspace, workspaceProps(rows, {
      profileId: '00000000-0000-4000-8000-000000000002',
    }))));
    expect(host.textContent).toContain('No campaigns selected');
  });

  it('renders explicit ineligible reasons and disables every run control for a viewer', () => {
    const rows = [
      row(1),
      row(2, {
        eligibilityReason: 'Only Sponsored Products campaigns support bid previews.',
        selectable: false,
        adProduct: 'SB',
      }),
    ];
    const { host } = mount(rows, { mayRunOptimizer: false });
    expect(host.textContent).toContain('Only Sponsored Products campaigns support bid previews.');
    expect(host.textContent).toContain('Your role can view previews but cannot queue one.');
    expect(host.querySelector<HTMLButtonElement>('[data-testid="optimizer-run-preview"]')?.disabled).toBe(true);
    expect([...host.querySelectorAll<HTMLInputElement>('[data-testid="optimizer-campaign-select"]')]
      .every((checkbox) => checkbox.disabled)).toBe(true);
    expect(host.querySelector<HTMLInputElement>('[data-testid="optimizer-select-filtered"]')?.disabled).toBe(true);
  });

  it('keeps campaign selection available while deployment readiness disables only preview enqueue', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { host } = mount([row(1), row(2)], { previewReady: false });
    const first = host.querySelector<HTMLInputElement>('[data-testid="optimizer-campaign-select"]');
    expect(first?.disabled).toBe(false);
    act(() => first?.click());
    expect(host.textContent).toContain('1 campaign selected');

    const run = host.querySelector<HTMLButtonElement>('[data-testid="optimizer-run-preview"]');
    expect(run?.disabled).toBe(true);
    expect(host.textContent).toContain('Recommendation previews are temporarily unavailable.');
    act(() => run?.click());
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses an all-campaign preview when the eligible roster exceeds the server bound', () => {
    const { host } = mount(
      Array.from({ length: 10_001 }, (_, index) => row(index + 1)),
    );
    expect(footerText(host)).toContain('10,001 of 10,001 rows');
    expect(host.querySelectorAll<HTMLInputElement>('input[name="optimizer-preview-scope"]')
      .item(0).disabled).toBe(true);
    expect(host.querySelector<HTMLButtonElement>('[data-testid="optimizer-run-preview"]')?.disabled)
      .toBe(true);
    expect(host.textContent).toContain('One preview supports at most 10,000 campaigns');
    expect(host.textContent).toContain('Select a smaller campaign set');
  });

  it('polls without overlap, refreshes once on success, and exposes every successful child review', async () => {
    vi.useFakeTimers();
    window.history.replaceState({}, '', '/optimizer?profile=00000000-0000-4000-8000-000000000001&from=2026-08-01');
    const accepted = {
      batchId: 'batch-one',
      status: 'queued',
      scope: { mode: 'all', campaignCount: 2, fingerprint: 'a'.repeat(64) },
      childCount: 2,
    };
    const queued = {
      batchId: 'batch-one', status: 'queued', campaignCount: 2, proposalsCount: 0,
      children: [
        { runId: 'run-one', groupName: 'Synthetic group', status: 'queued', campaignCount: 1, proposalsCount: 0 },
        { runId: 'run-two', groupName: null, status: 'queued', campaignCount: 1, proposalsCount: 0 },
      ],
    };
    const running = {
      ...queued,
      status: 'running',
      children: queued.children.map((child) => ({ ...child, status: 'running' })),
    };
    const succeeded = {
      ...queued,
      status: 'succeeded',
      proposalsCount: 1,
      children: [
        { ...queued.children[0], status: 'succeeded', proposalsCount: 1 },
        { ...queued.children[1], status: 'succeeded' },
      ],
    };
    const responses = [accepted, queued, running, succeeded];
    const fetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => Response.json(responses.shift()),
    );
    vi.stubGlobal('fetch', fetch);
    const { host } = mount([row(1), row(2)]);
    const run = host.querySelector<HTMLButtonElement>('[data-testid="optimizer-run-preview"]');
    await act(async () => run?.click());

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(window.location.search).toContain('batch=batch-one');
    expect(run?.disabled).toBe(true);
    expect(host.querySelector('.wa-optimizer-preview')?.getAttribute('aria-busy')).toBe('true');

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(fetch.mock.calls[1]?.[0]).toBe('/api/optimizer/runs/batch-one?profileId=00000000-0000-4000-8000-000000000001');
    expect(host.textContent).toContain('Preview queued for 2 campaigns');
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(host.textContent).toContain('Preview running for 2 campaigns');
    await act(async () => vi.advanceTimersByTimeAsync(5_000));

    expect(host.textContent).toContain('Preview completed with 1 recommendation to review');
    expect(navigation.refresh).toHaveBeenCalledTimes(1);
    const reviews = [...host.querySelectorAll<HTMLAnchorElement>('[aria-label="Preview runs"] a')];
    expect(reviews).toHaveLength(2);
    expect(reviews[0]?.href).toContain('/recommendations?profile=00000000-0000-4000-8000-000000000001&run=run-one');
    expect(run?.disabled).toBe(false);
  });

  it('resumes polling from the batch URL after reload and aborts it when the profile changes', async () => {
    vi.useFakeTimers();
    const statusSignals: AbortSignal[] = [];
    const pending = new Promise<Response>(() => undefined);
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal !== undefined && init.signal !== null) statusSignals.push(init.signal);
      return pending;
    });
    vi.stubGlobal('fetch', fetch);
    const rows = [row(1)];
    const { host, root } = mount(rows, { initialBatchId: 'batch-resume', previewReady: false });
    expect(host.querySelector<HTMLButtonElement>('[data-testid="optimizer-run-preview"]')?.disabled).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toContain('/api/optimizer/runs/batch-resume?profileId=');

    act(() => root.render(createElement(CampaignWorkspace, workspaceProps(rows, {
      initialBatchId: null,
      profileId: '00000000-0000-4000-8000-000000000002',
    }))));
    expect(statusSignals[0]?.aborted).toBe(true);
  });

  it('clears an unreadable batch URL and re-enables a fresh preview', async () => {
    vi.useFakeTimers();
    window.history.replaceState({}, '', '/optimizer?profile=00000000-0000-4000-8000-000000000001&batch=foreign-batch');
    const fetch = vi.fn(async () => Response.json({ error: 'Not found' }, { status: 404 }));
    vi.stubGlobal('fetch', fetch);
    const { host } = mount([row(1)], { initialBatchId: 'foreign-batch' });
    const run = host.querySelector<HTMLButtonElement>('[data-testid="optimizer-run-preview"]');
    expect(run?.disabled).toBe(true);

    await act(async () => vi.advanceTimersByTimeAsync(1_000));

    expect(host.textContent).toContain('Not found');
    expect(run?.disabled).toBe(false);
    expect(window.location.search).not.toContain('batch=');
  });

  it('retries a transient status failure and preserves partial child review links on terminal failure', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({
        batchId: 'batch-partial', status: 'queued',
        scope: { mode: 'all', campaignCount: 2, fingerprint: 'c'.repeat(64) }, childCount: 2,
      }))
      .mockResolvedValueOnce(Response.json({ error: 'temporary status outage' }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({
        batchId: 'batch-partial', status: 'failed', campaignCount: 2, proposalsCount: 1,
        children: [
          { runId: 'run-complete', groupName: 'Completed group', status: 'succeeded', campaignCount: 1, proposalsCount: 1 },
          { runId: 'run-failed', groupName: null, status: 'failed', campaignCount: 1, proposalsCount: 0 },
        ],
      }));
    vi.stubGlobal('fetch', fetch);
    const { host } = mount([row(1), row(2)]);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="optimizer-run-preview"]')?.click());
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(host.textContent).toContain('temporarily unavailable. Retrying automatically');
    await act(async () => vi.advanceTimersByTimeAsync(2_000));

    expect(host.textContent).toContain('Preview failed. 1 recommendation remains available');
    expect(navigation.refresh).toHaveBeenCalledTimes(1);
    const links = [...host.querySelectorAll<HTMLAnchorElement>('[aria-label="Preview runs"] a')];
    expect(links).toHaveLength(1);
    expect(links[0]?.href).toContain('run=run-complete');
    expect(host.querySelector<HTMLButtonElement>('[data-testid="optimizer-run-preview"]')?.disabled).toBe(false);
  });

  it('stops after ten visible observation minutes without claiming terminal state', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => Response.json({
      batchId: 'batch-observe', status: 'queued', campaignCount: 1, proposalsCount: 0,
      children: [{ runId: 'run-observe', groupName: null, status: 'queued', campaignCount: 1, proposalsCount: 0 }],
    }));
    vi.stubGlobal('fetch', fetch);
    const { host } = mount([row(1)], { initialBatchId: 'batch-observe' });
    await act(async () => vi.advanceTimersByTimeAsync(10 * 60 * 1_000));

    expect(host.textContent).toContain('Automatic status checks stopped after ten minutes');
    expect(host.textContent).toContain('The preview may still complete in the background');
    expect(host.textContent).not.toContain('Preview completed');
    expect(navigation.refresh).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLButtonElement>('[data-testid="optimizer-run-preview"]')?.disabled).toBe(true);
  });

  it('aborts a status request that never settles when the visible deadline expires', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal !== undefined && init.signal !== null) signals.push(init.signal);
      return new Promise<Response>(() => undefined);
    });
    vi.stubGlobal('fetch', fetch);
    const { host } = mount([row(1)], { initialBatchId: 'batch-hung' });

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(signals[0]?.aborted).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(10 * 60 * 1_000 - 1_000));

    expect(signals[0]?.aborted).toBe(true);
    expect(host.textContent).toContain('Automatic status checks stopped after ten minutes');
    expect(host.textContent).not.toContain('Preview completed');
  });

  it('never overlaps status requests and does not consume the observation budget while hidden', async () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    let resolveStatus!: (response: Response) => void;
    const pendingStatus = new Promise<Response>((resolve) => { resolveStatus = resolve; });
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({
        batchId: 'batch-slow', status: 'queued',
        scope: { mode: 'all', campaignCount: 1, fingerprint: 'b'.repeat(64) }, childCount: 1,
      }))
      .mockReturnValueOnce(pendingStatus)
      .mockResolvedValue(Response.json({
        batchId: 'batch-slow', status: 'queued', campaignCount: 1, proposalsCount: 0,
        children: [{ runId: 'run-slow', groupName: null, status: 'queued', campaignCount: 1, proposalsCount: 0 }],
      }));
    vi.stubGlobal('fetch', fetch);
    const { host } = mount([row(1)]);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="optimizer-run-preview"]')?.click());
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(fetch).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(fetch).toHaveBeenCalledTimes(2);

    visibility = 'hidden';
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    resolveStatus(Response.json({
      batchId: 'batch-slow', status: 'queued', campaignCount: 1, proposalsCount: 0,
      children: [{ runId: 'run-slow', groupName: null, status: 'queued', campaignCount: 1, proposalsCount: 0 }],
    }));
    await act(async () => pendingStatus);
    await act(async () => vi.advanceTimersByTimeAsync(15 * 60 * 1_000));
    expect(host.textContent).not.toContain('Automatic status checks stopped');

    visibility = 'visible';
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(host.textContent).not.toContain('Automatic status checks stopped');
  });

  it('reuses an idempotency key only while an exact-scope response remains uncertain', async () => {
    const fetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
      async () => { throw new TypeError('connection interrupted'); },
    );
    vi.stubGlobal('fetch', fetch);
    const { host } = mount([row(1)]);
    const run = host.querySelector<HTMLButtonElement>('[data-testid="optimizer-run-preview"]');

    await act(async () => run?.click());
    await act(async () => run?.click());
    expect(fetch).toHaveBeenCalledTimes(4);
    const firstBodies = fetch.mock.calls.slice(0, 4).map((call) =>
      JSON.parse((call[1] as RequestInit).body as string) as { clientRequestId: string },
    );
    expect(new Set(firstBodies.map((body) => body.clientRequestId)).size).toBe(1);

    const firstCampaign = host.querySelector<HTMLInputElement>('[data-testid="optimizer-campaign-select"]');
    act(() => firstCampaign?.click());
    await act(async () => run?.click());
    const changedBody = JSON.parse((fetch.mock.calls[4]?.[1] as RequestInit).body as string) as {
      clientRequestId: string;
      scope: { mode: string };
    };
    expect(changedBody.scope.mode).toBe('selected');
    expect(changedBody.clientRequestId).not.toBe(firstBodies[0]?.clientRequestId);
  });
});
