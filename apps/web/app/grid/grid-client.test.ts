// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LAYOUT_WRITE_DELAY_MS, columnsFor } from '@wizard-ads/ui';
import type {
  EntityLevel,
  GridRow,
  SavedView,
  SynchronousLayoutSource,
  ViewStore,
} from '@wizard-ads/ui';
import { GridWorkspace, experimentScopeIds, withValidGrouping } from './grid-client';

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => navigation }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: Array<{ unmount: () => void }> = [];

afterEach(() => {
  act(() => {
    for (const root of mounted.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  navigation.push.mockReset();
  vi.unstubAllGlobals();
});

function view(groupBy: readonly string[]): SavedView {
  return {
    id: 'synthetic-view',
    name: 'Synthetic hierarchy',
    entity: 'search_terms',
    columns: ['search_term', 'spend'],
    pinned: ['search_term'],
    widths: {},
    filter: { groups: [] },
    sort: [],
    groupBy,
    dateRange: null,
    updatedAt: '2026-08-29T00:00:00.000Z',
  };
}

function scopedView(
  entity: EntityLevel,
  options: Pick<SavedView, 'columns' | 'filter' | 'sort' | 'groupBy'>,
): SavedView {
  return {
    id: `saved-${entity}`,
    name: `Saved ${entity}`,
    entity,
    columns: options.columns,
    pinned: [],
    widths: {},
    filter: options.filter,
    sort: options.sort,
    groupBy: options.groupBy,
    dateRange: null,
    updatedAt: '2026-08-29T00:00:00.000Z',
  };
}

function row(entity: EntityLevel): GridRow {
  return {
    id: entity === 'campaigns' ? 'campaign:c-1' : 'target:kw-1',
    dimensions:
      entity === 'campaigns'
        ? {
            campaign_id: 'c-1',
            campaign_name: 'Synthetic campaign',
            campaign_state: 'enabled',
            ad_product: 'SP',
          }
        : {
            target_id: 'kw-1',
            targeting: 'synthetic target',
            target_state: 'enabled',
            match_type: 'exact',
          },
    totals: { impressions: 100, clicks: 12, spend: 9, sales: 30, orders: 2, units: 2 },
    comparison: null,
    currencyCode: 'USD',
  };
}

class DeferredViewStore implements ViewStore {
  readonly remembered: SavedView[] = [];
  private readonly pending = new Map<EntityLevel, (view: SavedView | null) => void>();

  async list(): Promise<SavedView[]> {
    return [];
  }

  async save(): Promise<void> {}

  async remove(): Promise<void> {}

  lastLayout(entity: EntityLevel): Promise<SavedView | null> {
    return new Promise((resolve) => this.pending.set(entity, resolve));
  }

  async rememberLayout(layout: SavedView): Promise<void> {
    this.remembered.push(layout);
  }

  restore(entity: EntityLevel, layout: SavedView | null): void {
    const resolve = this.pending.get(entity);
    if (resolve === undefined) throw new Error(`No pending restoration for ${entity}`);
    this.pending.delete(entity);
    resolve(layout);
  }
}

class RejectingViewStore implements ViewStore {
  private readonly pending = new Map<EntityLevel, (error: Error) => void>();

  async list(): Promise<SavedView[]> {
    return [];
  }

  async save(): Promise<void> {}

  async remove(): Promise<void> {}

  lastLayout(entity: EntityLevel): Promise<SavedView | null> {
    return new Promise((_resolve, reject) => this.pending.set(entity, reject));
  }

  async rememberLayout(): Promise<void> {}

  fail(entity: EntityLevel): void {
    const reject = this.pending.get(entity);
    if (reject === undefined) throw new Error(`No pending restoration for ${entity}`);
    this.pending.delete(entity);
    reject(new Error(`Synthetic ${entity} store failure`));
  }
}

const freshness = {
  tone: 'muted' as const,
  headline: 'Synthetic report state',
  details: [],
  staleTypes: [],
  lossyTypes: [],
  coversThrough: null,
};

function workspaceProps(
  entity: EntityLevel,
  store: ViewStore | null,
): Parameters<typeof GridWorkspace>[0] {
  return {
    entity,
    currencyCode: 'USD',
    profileId: 'synthetic-profile',
    period: { start: '2026-08-01', end: '2026-08-29' },
    comparisonPeriod: { start: '2026-07-03', end: '2026-07-31' },
    freshness,
    campaignId: null,
    viewStore: store,
  };
}

function stubGridFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const entity = new URL(String(input), 'http://localhost').searchParams.get(
        'entity',
      ) as EntityLevel;
      const rows = [row(entity)];
      return Response.json({ rows, rowCount: rows.length, truncated: false });
    }),
  );
}

async function flushGridLoad(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('grid saved-view grouping', () => {
  it('binds readiness to the current entity and restores scope before allowing interactions', async () => {
    stubGridFetch();
    const store = new DeferredViewStore();
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    mounted.push(root);

    act(() => root.render(createElement(GridWorkspace, workspaceProps('campaigns', store))));
    await flushGridLoad();
    expect(host.querySelector('[data-testid="grid-data-ready"]')?.getAttribute('data-ready')).toBe('false');
    expect(host.querySelector('[data-testid="grid-layout-restoring"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="grid-scroller"]')).toBeNull();

    await act(async () => {
      store.restore(
        'campaigns',
        scopedView('campaigns', {
          columns: ['campaign_name', 'campaign_state', 'clicks', 'spend'],
          filter: {
            groups: [{ filters: [{ key: 'CAMPAIGN_ID', conditions: [{ operator: '=', values: ['c-1'] }] }] }],
          },
          sort: [{ columnId: 'clicks', direction: 'asc' }],
          groupBy: ['campaign_state'],
        }),
      );
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="grid-data-ready"]')?.getAttribute('data-ready')).toBe('true');
    expect(host.querySelector('[role="treegrid"]')).not.toBeNull();
    expect(host.querySelector('[role="columnheader"][aria-label="Clicks"]')?.getAttribute('aria-sort')).toBe('ascending');
    expect(host.querySelector<HTMLAnchorElement>('[data-testid="grid-start-experiment"]')?.getAttribute('href')).toContain('campaigns=c-1');

    // A prop-key change is synchronous. The old ready scope must never leak
    // through one render while the new target layout is still unresolved.
    act(() => root.render(createElement(GridWorkspace, workspaceProps('targets', store))));
    await flushGridLoad();
    expect(host.querySelector('[data-testid="grid-data-ready"]')?.getAttribute('data-ready')).toBe('false');
    expect(host.querySelector('[data-testid="grid-scroller"]')).toBeNull();
    expect(host.querySelector('[data-testid="grid-start-experiment"]')).toBeNull();

    await act(async () => {
      store.restore(
        'targets',
        scopedView('targets', {
          columns: ['targeting', 'match_type', 'spend'],
          filter: {
            groups: [{ filters: [{ key: 'TARGET_ID', conditions: [{ operator: '=', values: ['kw-1'] }] }] }],
          },
          sort: [{ columnId: 'spend', direction: 'desc' }],
          groupBy: ['match_type'],
        }),
      );
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="grid-data-ready"]')?.getAttribute('data-ready')).toBe('true');
    expect(host.querySelector<HTMLAnchorElement>('[data-testid="grid-start-experiment"]')?.getAttribute('href')).toContain('targets=kw-1');
    const spend = host.querySelector<HTMLElement>('[role="columnheader"][aria-label="Spend"]');
    expect(spend?.getAttribute('aria-sort')).toBe('descending');
    await act(async () => {
      spend?.click();
      await Promise.resolve();
    });
    expect(spend?.getAttribute('aria-sort')).toBe('ascending');
    expect(store.remembered.at(-1)?.sort).toEqual([{ columnId: 'spend', direction: 'asc' }]);
  });

  it('falls open to the exact default scope and ignores rejection from a cancelled scope', async () => {
    stubGridFetch();
    const store = new RejectingViewStore();
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    mounted.push(root);

    act(() => root.render(createElement(GridWorkspace, workspaceProps('campaigns', store))));
    await flushGridLoad();
    await act(async () => {
      store.fail('campaigns');
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="grid-data-ready"]')?.getAttribute('data-ready')).toBe('true');
    expect(host.querySelector('[role="grid"]')).not.toBeNull();
    expect(host.querySelector('[role="columnheader"][aria-label="Spend"]')?.getAttribute('aria-sort')).toBe('descending');
    expect(host.querySelector<HTMLAnchorElement>('[data-testid="grid-start-experiment"]')?.getAttribute('href')).toContain('campaigns=c-1');

    act(() => root.render(createElement(GridWorkspace, workspaceProps('targets', store))));
    await flushGridLoad();
    act(() => root.render(createElement(GridWorkspace, workspaceProps('ad_groups', store))));
    await flushGridLoad();
    expect(host.querySelector('[data-testid="grid-data-ready"]')?.getAttribute('data-ready')).toBe('false');

    await act(async () => {
      store.fail('targets');
      await Promise.resolve();
    });
    expect(host.querySelector('[data-testid="grid-data-ready"]')?.getAttribute('data-ready')).toBe('false');
    expect(host.querySelector('[data-testid="grid-scroller"]')).toBeNull();

    await act(async () => {
      store.fail('ad_groups');
      await Promise.resolve();
    });
    expect(host.querySelector('[data-testid="grid-data-ready"]')?.getAttribute('data-ready')).toBe('true');
    expect(host.querySelector('[role="grid"]')).not.toBeNull();
  });

  it('preserves three valid levels in their saved order', () => {
    const normalized = withValidGrouping(
      view(['campaign_name', 'ad_group_name', 'match_type']),
      columnsFor('search_terms'),
    );
    expect(normalized.groupBy).toEqual(['campaign_name', 'ad_group_name', 'match_type']);
  });

  it('drops duplicates, unavailable dimensions and malformed legacy state', () => {
    const normalized = withValidGrouping(
      view(['campaign_name', 'campaign_name', 'not_a_column', 'match_type']),
      columnsFor('search_terms'),
    );
    expect(normalized.groupBy).toEqual(['campaign_name', 'match_type']);

    const malformed = { ...view([]), groupBy: undefined } as unknown as SavedView;
    expect(withValidGrouping(malformed, columnsFor('search_terms')).groupBy).toEqual([]);
  });

  it('keeps first-seen experiment ids stable and stops after 100 unique values', () => {
    const ordered = ['scope-b', 'scope-a', 'scope-b', ...Array.from({ length: 98 }, (_, index) => `scope-${index}`)];
    const rows: GridRow[] = ordered.map((campaignId, index) => ({
      ...row('campaigns'),
      id: `campaign-row-${index}`,
      dimensions: { ...row('campaigns').dimensions, campaign_id: campaignId },
    }));
    rows.push({
      ...row('campaigns'),
      id: 'must-not-be-read',
      dimensions: new Proxy<Record<string, string | number | boolean | null>>({}, {
        get: () => {
          throw new Error('scope collection read beyond its 100-id bound');
        },
      }),
    });

    expect(experimentScopeIds(rows, 'campaign_id')).toEqual([
      'scope-b',
      'scope-a',
      ...Array.from({ length: 98 }, (_, index) => `scope-${index}`),
    ]);
  });
});

describe('grid density and grouped headers', () => {
  it('persists the density beside the widths and keeps dimension headers on screen while grouped', async () => {
    stubGridFetch();
    const store = new DeferredViewStore();
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    mounted.push(root);

    act(() => root.render(createElement(GridWorkspace, workspaceProps('campaigns', store))));
    await flushGridLoad();
    await act(async () => {
      store.restore(
        'campaigns',
        scopedView('campaigns', {
          columns: ['campaign_name', 'campaign_state', 'ad_product', 'clicks', 'spend'],
          filter: { groups: [] },
          sort: [],
          groupBy: ['campaign_state'],
        }),
      );
      await Promise.resolve();
    });

    // Grouped by state: the group column leads and is pinned, and the other
    // dimension headers (the drag sources for nesting) are still rendered.
    const headers = [...host.querySelectorAll<HTMLElement>('[role="columnheader"]')].map(
      (header) => header.getAttribute('aria-label'),
    );
    expect(headers).toEqual(['State', 'Campaign', 'Ad type', 'Clicks', 'Spend']);
    expect(host.querySelector('[data-testid="grid-shell"]')?.getAttribute('data-density')).toBe('normal');
    expect(host.querySelector('[data-testid="grid-scroller"]')?.getAttribute('style')).not.toContain('620px');

    const density = host.querySelector<HTMLSelectElement>('select[aria-label="Row density"]');
    expect(density).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      setter?.call(density, 'compact');
      density?.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    expect(host.querySelector('[data-testid="grid-shell"]')?.getAttribute('data-density')).toBe('compact');
    expect(store.remembered.at(-1)?.density).toBe('compact');
    expect(store.remembered.at(-1)?.columns).toEqual([
      'campaign_name',
      'campaign_state',
      'ad_product',
      'clicks',
      'spend',
    ]);
  });
});

/**
 * A store that can answer without waiting, plus one that can be made to answer
 * late and differently — the two halves of "restore fast, and never let a slow
 * answer overwrite what the operator has already done".
 */
class CachedViewStore implements ViewStore, SynchronousLayoutSource {
  readonly remembered: SavedView[] = [];
  readonly asked: EntityLevel[] = [];
  private late: SavedView | null = null;
  private resolveLate: ((layout: SavedView | null) => void) | null = null;

  constructor(private readonly cached: Partial<Record<EntityLevel, SavedView>>) {}

  cachedLayout(entity: EntityLevel): SavedView | null {
    return this.cached[entity] ?? null;
  }

  async list(): Promise<SavedView[]> {
    return [];
  }

  async save(): Promise<void> {}

  async remove(): Promise<void> {}

  lastLayout(entity: EntityLevel): Promise<SavedView | null> {
    this.asked.push(entity);
    return new Promise((resolve) => {
      this.resolveLate = resolve;
      if (this.late !== null) {
        resolve(this.late);
        this.late = null;
      }
    });
  }

  async rememberLayout(layout: SavedView): Promise<void> {
    this.remembered.push(layout);
  }

  /** Answer an outstanding asynchronous restoration with a different layout. */
  answerLate(layout: SavedView | null): void {
    if (this.resolveLate === null) this.late = layout;
    else {
      this.resolveLate(layout);
      this.resolveLate = null;
    }
  }
}

describe('grid first paint', () => {
  it('opens on the remembered layout with no restoring state when the store can answer synchronously', async () => {
    stubGridFetch();
    const store = new CachedViewStore({
      campaigns: scopedView('campaigns', {
        columns: ['campaign_name', 'campaign_state', 'clicks', 'spend'],
        filter: { groups: [] },
        sort: [{ columnId: 'clicks', direction: 'asc' }],
        groupBy: ['campaign_state'],
      }),
    });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    mounted.push(root);

    act(() => root.render(createElement(GridWorkspace, workspaceProps('campaigns', store))));
    await flushGridLoad();

    // The operator's own layout on the first frame the rows allow: no
    // "Restoring your saved grid layout…" gate, and the grid is interactive.
    expect(host.querySelector('[data-testid="grid-layout-restoring"]')).toBeNull();
    expect(host.querySelector('[data-testid="grid-data-ready"]')?.getAttribute('data-ready')).toBe('true');
    expect(host.querySelector('[role="treegrid"]')).not.toBeNull();
    expect(
      host.querySelector('[role="columnheader"][aria-label="Clicks"]')?.getAttribute('aria-sort'),
    ).toBe('ascending');
    // Nothing was asked for asynchronously, because nothing needed to be.
    expect(store.asked).toEqual([]);

    // A late answer that disagrees cannot take the layout back: the operator
    // has been working in this grid since the first frame.
    const spend = host.querySelector<HTMLElement>('[role="columnheader"][aria-label="Spend"]');
    await act(async () => {
      spend?.click();
      await Promise.resolve();
    });
    expect(spend?.getAttribute('aria-sort')).toBe('descending');
    await act(async () => {
      store.answerLate(
        scopedView('campaigns', {
          columns: ['campaign_name', 'spend'],
          filter: { groups: [] },
          sort: [{ columnId: 'spend', direction: 'asc' }],
          groupBy: [],
        }),
      );
      await Promise.resolve();
    });
    expect(spend?.getAttribute('aria-sort')).toBe('descending');
    expect(host.querySelector('[role="treegrid"]')).not.toBeNull();
  });

  it('re-reads the cache when a campaign deep link is dropped, and keeps no filter from it', async () => {
    stubGridFetch();
    const store = new CachedViewStore({
      campaigns: scopedView('campaigns', {
        columns: ['campaign_name', 'campaign_state', 'clicks', 'spend'],
        filter: { groups: [] },
        sort: [{ columnId: 'clicks', direction: 'asc' }],
        groupBy: [],
      }),
    });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    mounted.push(root);
    const clicksSort = (): string | null | undefined =>
      host
        .querySelector('[role="columnheader"][aria-label="Clicks"]')
        ?.getAttribute('aria-sort');

    act(() => root.render(createElement(GridWorkspace, workspaceProps('campaigns', store))));
    await flushGridLoad();
    expect(clicksSort()).toBe('ascending');

    // A campaign deep link does not change the row request, so nothing is
    // remounted: this scope has no cached layout and opens on the scoped
    // default, filter chip and all.
    act(() =>
      root.render(
        createElement(GridWorkspace, { ...workspaceProps('campaigns', store), campaignId: 'c-1' }),
      ),
    );
    await flushGridLoad();
    await act(async () => {
      store.answerLate(null);
      await Promise.resolve();
    });
    expect(store.asked).toEqual(['campaigns']);
    expect(host.querySelector('[aria-label="Remove filter CAMPAIGN_ID"]')).not.toBeNull();

    // Dropping the deep link returns to a scope that was restored once
    // already. It must be read again, or the grid stays on the campaign's
    // view — and silently on its CAMPAIGN_ID filter.
    act(() => root.render(createElement(GridWorkspace, workspaceProps('campaigns', store))));
    await flushGridLoad();
    expect(host.querySelector('[aria-label="Remove filter CAMPAIGN_ID"]')).toBeNull();
    expect(clicksSort()).toBe('ascending');
    expect(host.querySelector('[data-testid="grid-data-ready"]')?.getAttribute('data-ready')).toBe('true');
    // Restored synchronously again, so nothing was asked for a second time.
    expect(store.asked).toEqual(['campaigns']);
  });

  it('writes the first layout change at once and collapses the rest of a burst into one write', async () => {
    stubGridFetch();
    const store = new CachedViewStore({
      campaigns: scopedView('campaigns', {
        columns: ['campaign_name', 'campaign_state', 'clicks', 'spend'],
        filter: { groups: [] },
        sort: [],
        groupBy: [],
      }),
    });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    mounted.push(root);

    act(() => root.render(createElement(GridWorkspace, workspaceProps('campaigns', store))));
    await flushGridLoad();
    expect(store.remembered).toHaveLength(0);

    const spend = host.querySelector<HTMLElement>('[role="columnheader"][aria-label="Spend"]');
    const clicks = host.querySelector<HTMLElement>('[role="columnheader"][aria-label="Clicks"]');
    await act(async () => {
      spend?.click();
      spend?.click();
      clicks?.click();
      await Promise.resolve();
    });

    // One write for the burst, not three: the leading change is persisted at
    // once and the rest are still in the buffer.
    expect(store.remembered).toHaveLength(1);
    expect(store.remembered[0]?.sort).toEqual([{ columnId: 'spend', direction: 'desc' }]);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, DEFAULT_LAYOUT_WRITE_DELAY_MS + 60));
    });
    // The state the operator ended on is the state that survives.
    expect(store.remembered).toHaveLength(2);
    expect(store.remembered.at(-1)?.sort).toEqual([{ columnId: 'clicks', direction: 'desc' }]);
  });
});
