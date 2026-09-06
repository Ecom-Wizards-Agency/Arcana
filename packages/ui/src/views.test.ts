import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_LAYOUT_WRITE_DELAY_MS,
  LayoutWriteBuffer,
  LocalViewStore,
  MemoryViewStore,
  hasCachedLayout,
  newViewId,
} from './views.js';
import type { KeyValueStorage, SavedView, ViewStore } from './views.js';

function view(overrides: Partial<SavedView> = {}): SavedView {
  return {
    id: newViewId(),
    name: 'Monday pacing',
    entity: 'campaigns',
    columns: ['campaign_name', 'spend', 'acos'],
    pinned: ['campaign_name'],
    widths: { campaign_name: 320 },
    filter: { groups: [{ filters: [{ key: 'ACOS', conditions: [{ operator: '>', values: ['30'] }] }] }] },
    sort: [{ columnId: 'spend', direction: 'desc' }],
    groupBy: [],
    dateRange: null,
    updatedAt: '2026-08-14T09:00:00Z',
    ...overrides,
  };
}

class FakeStorage implements KeyValueStorage {
  constructor(private readonly map = new Map<string, string>()) {}
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  poison(key: string): void {
    this.map.set(key, '{not json');
  }
  put(key: string, value: unknown): void {
    this.map.set(key, JSON.stringify(value));
  }
}

describe.each([
  ['memory', () => new MemoryViewStore()],
  ['local', () => new LocalViewStore(new FakeStorage())],
] as const)('%s view store', (_label, build) => {
  it('round-trips a named view and scopes the list to its entity level', async () => {
    const store = build();
    const campaigns = view();
    const terms = view({ name: 'Harvest candidates', entity: 'search_terms' });
    await store.save(campaigns);
    await store.save(terms);

    expect(await store.list('campaigns')).toEqual([campaigns]);
    expect(await store.list('search_terms')).toEqual([terms]);
    expect(await store.list('targets')).toEqual([]);
  });

  it('carries the whole lens: columns, pinning, widths, filter, sort, group-by', async () => {
    const store = build();
    const saved = view({
      entity: 'search_terms',
      groupBy: ['campaign_name', 'ad_group_name', 'match_type'],
    });
    await store.save(saved);
    const [loaded] = await store.list('search_terms');
    expect(loaded).toEqual(saved);
    expect(loaded?.groupBy).toEqual(['campaign_name', 'ad_group_name', 'match_type']);
  });

  it('round-trips every selected value in a categorical multi-select filter', async () => {
    const store = build();
    const saved = view({
      filter: {
        groups: [{
          filters: [{
            key: 'CAMPAIGN_STATE',
            conditions: [{ operator: 'IN', values: ['enabled', 'paused'] }],
          }],
        }],
      },
    });
    await store.save(saved);
    const [loaded] = await store.list('campaigns');
    expect(loaded?.filter.groups[0]?.filters[0]?.conditions[0]?.values).toEqual([
      'enabled',
      'paused',
    ]);
  });

  it('carries no profile id, so one view applies to any profile', async () => {
    const store = build();
    await store.save(view());
    const [loaded] = await store.list('campaigns');
    expect(Object.keys(loaded as SavedView)).not.toContain('profileId');
  });

  it('removes a view', async () => {
    const store = build();
    const saved = view();
    await store.save(saved);
    await store.remove(saved.id);
    expect(await store.list('campaigns')).toEqual([]);
  });

  it('remembers a per-entity layout separately from the named views', async () => {
    const store = build();
    const layout = view({ name: 'implicit' });
    await store.rememberLayout(layout);
    expect(await store.lastLayout('campaigns')).toEqual(layout);
    expect(await store.lastLayout('targets')).toBeNull();
    // The implicit layout is not a named view.
    expect(await store.list('campaigns')).toEqual([]);
  });

  it('sorts named views by name', async () => {
    const store = build();
    await store.save(view({ name: 'Zebra' }));
    await store.save(view({ name: 'Alpha' }));
    expect((await store.list('campaigns')).map((v) => v.name)).toEqual(['Alpha', 'Zebra']);
  });
});

describe('LocalViewStore resilience', () => {
  it('treats a corrupt entry as "no saved views" rather than throwing', async () => {
    const storage = new FakeStorage();
    const store = new LocalViewStore(storage);
    await store.save(view());
    storage.poison('wizard-ads:views:v1');

    await expect(store.list('campaigns')).resolves.toEqual([]);
    await expect(store.lastLayout('campaigns')).resolves.toBeNull();
  });

  it.each([
    ['null root', null, null],
    ['array root', [], []],
    ['null member', { bad: null }, { campaigns: null }],
    ['wrong view shape', { bad: { entity: 'campaigns' } }, { campaigns: { entity: 'campaigns' } }],
    ['wrong layout entity', {}, { campaigns: view({ entity: 'targets' }) }],
  ])('treats %s as empty local state', async (_case, named, layouts) => {
    const storage = new FakeStorage();
    storage.put('wizard-ads:views:v1', named);
    storage.put('wizard-ads:layout:v1', layouts);
    const store = new LocalViewStore(storage);

    await expect(store.list('campaigns')).resolves.toEqual([]);
    await expect(store.lastLayout('campaigns')).resolves.toBeNull();
  });

  it('keeps valid named views while dropping malformed siblings', async () => {
    const storage = new FakeStorage();
    const valid = view({ id: 'valid-view' });
    storage.put('wizard-ads:views:v1', { valid, bad: null });
    const store = new LocalViewStore(storage);

    await expect(store.list('campaigns')).resolves.toEqual([valid]);
  });

  it('survives a storage that refuses to write', async () => {
    const store = new LocalViewStore({
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    });
    await expect(store.save(view())).resolves.toBeUndefined();
  });
});

describe('newViewId', () => {
  it('does not collide across a batch', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newViewId()));
    expect(ids.size).toBe(500);
  });
});

describe('density in the saved layout', () => {
  it('persists a density beside the widths and rejects an unknown one', async () => {
    const storage = new FakeStorage();
    const store = new LocalViewStore(storage);
    await store.rememberLayout(view({ density: 'compact' }));
    expect((await store.lastLayout('campaigns'))?.density).toBe('compact');

    // A layout written before density existed carries none and still restores.
    const legacy = view();
    delete (legacy as { density?: unknown }).density;
    await store.rememberLayout(legacy);
    expect(await store.lastLayout('campaigns')).toEqual(legacy);

    storage.put('wizard-ads:layout:v1', { campaigns: { ...view(), density: 'dense' } });
    expect(await store.lastLayout('campaigns')).toBeNull();
  });
});

describe('synchronous layout restoration', () => {
  it('answers the remembered layout with no round trip, and refuses what it cannot trust', async () => {
    const storage = new FakeStorage();
    const store = new LocalViewStore(storage);
    const layout = view({ density: 'compact' });
    await store.rememberLayout(layout);

    // The same answer as the promise, without the promise. A caller may render
    // the operator's own layout on the first frame rather than a placeholder.
    expect(store.cachedLayout('campaigns')).toEqual(layout);
    expect(store.cachedLayout('campaigns')).toEqual(await store.lastLayout('campaigns'));
    expect(hasCachedLayout(store)).toBe(true);
    // A store that cannot answer synchronously must not be asked to pretend.
    expect(hasCachedLayout(new MemoryViewStore())).toBe(false);
    expect(hasCachedLayout(null)).toBe(false);

    // Every defence the asynchronous read had is still in force.
    expect(store.cachedLayout('targets')).toBeNull();
    storage.put('wizard-ads:layout:v1', { campaigns: { ...view(), density: 'dense' } });
    expect(store.cachedLayout('campaigns')).toBeNull();
    storage.poison('wizard-ads:layout:v1');
    expect(store.cachedLayout('campaigns')).toBeNull();
  });
});

describe('LayoutWriteBuffer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  class RecordingStore implements ViewStore {
    readonly remembered: SavedView[] = [];
    async list(): Promise<SavedView[]> {
      return [];
    }
    async save(): Promise<void> {}
    async remove(): Promise<void> {}
    async lastLayout(): Promise<SavedView | null> {
      return null;
    }
    async rememberLayout(layout: SavedView): Promise<void> {
      this.remembered.push(layout);
    }
  }

  it('writes the first change at once and collapses a gesture into one trailing write', () => {
    vi.useFakeTimers();
    const store = new RecordingStore();
    const buffer = new LayoutWriteBuffer(store);

    // A column drag: forty mouse moves, forty layout states, one width each.
    for (let width = 200; width < 240; width += 1) {
      buffer.remember(view({ widths: { campaign_name: width } }));
    }
    // The first lands immediately, so a single click is never deferred.
    expect(store.remembered).toHaveLength(1);
    expect(store.remembered[0]?.widths['campaign_name']).toBe(200);

    vi.advanceTimersByTime(DEFAULT_LAYOUT_WRITE_DELAY_MS);
    // The other thirty-nine collapse into the one state that survived them.
    expect(store.remembered).toHaveLength(2);
    expect(store.remembered[1]?.widths['campaign_name']).toBe(239);

    // The window closes when the gesture stops; nothing keeps writing.
    vi.advanceTimersByTime(DEFAULT_LAYOUT_WRITE_DELAY_MS * 5);
    expect(store.remembered).toHaveLength(2);
  });

  it('flushes the last state of a gesture rather than dropping it', () => {
    vi.useFakeTimers();
    const store = new RecordingStore();
    const buffer = new LayoutWriteBuffer(store);

    buffer.remember(view({ widths: { campaign_name: 200 } }));
    buffer.remember(view({ widths: { campaign_name: 260 } }));
    // The operator navigates away mid-gesture: the queued state is the one
    // they will come back to, so it must not be the one that is lost.
    buffer.flush();
    expect(store.remembered.map((layout) => layout.widths['campaign_name'])).toEqual([200, 260]);

    // Flushing an empty buffer writes nothing and cancels the window.
    buffer.flush();
    vi.advanceTimersByTime(DEFAULT_LAYOUT_WRITE_DELAY_MS * 3);
    expect(store.remembered).toHaveLength(2);
  });

  it('keeps persisting after a rejected write instead of stopping at it', async () => {
    vi.useFakeTimers();
    const offered: SavedView[] = [];
    const buffer = new LayoutWriteBuffer({
      list: async () => [],
      save: async () => {},
      remove: async () => {},
      lastLayout: async () => null,
      rememberLayout: async (layout: SavedView) => {
        offered.push(layout);
        // A full quota, a private-mode storage, a rejected remote store: the
        // gesture continues and the next state is still offered.
        throw new Error('QuotaExceededError');
      },
    });

    buffer.remember(view({ widths: { campaign_name: 200 } }));
    buffer.remember(view({ widths: { campaign_name: 260 } }));
    vi.advanceTimersByTime(DEFAULT_LAYOUT_WRITE_DELAY_MS);
    buffer.remember(view({ widths: { campaign_name: 300 } }));
    await vi.advanceTimersByTimeAsync(DEFAULT_LAYOUT_WRITE_DELAY_MS);
    expect(offered.map((layout) => layout.widths['campaign_name'])).toEqual([200, 260, 300]);
  });
});
