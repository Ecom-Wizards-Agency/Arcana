/**
 * Saved views: columns + filters + sort + group-by + date range, named.
 *
 * The recon (`https://github.com/Ecom-Wizards-Agency/openspell/blob/1ca9bd7c253e2a3f6b8c8b5848ee7bfad695781f/tools/recon/02-data-grid.md` §5) found that AdLabs has *one implicit
 * remembered layout per user* -- no named presets, no per-view filter sets, no
 * sharing. Its verdict, and ours: clone the auto-persisted layout, beat it with
 * named views that bundle the lens rather than the result.
 *
 * A view is a **lens**, and that word is load-bearing: it deliberately carries
 * no profile id. "My Monday pacing view" is worth having precisely because it
 * applies to any of the profiles an agency runs; binding it to one would make
 * it fifteen views that drift apart, which is the exact failure the recon
 * records in AdLabs' dashboard duplication model (`https://github.com/Ecom-Wizards-Agency/openspell/blob/1ca9bd7c253e2a3f6b8c8b5848ee7bfad695781f/tools/recon/03-dashboards.md` §6).
 *
 * ## Storage
 *
 * `ViewStore` is a port with two implementations here: in-memory (tests) and
 * `localStorage` (the browser). Both are per-user by construction because the
 * storage is. A shared, org-scoped, DB-backed store needs a `grid_views` table,
 * which belongs to WP-01's migrations -- so this file defines the interface it
 * would implement and stops there rather than inventing a schema across an
 * ownership line.
 */
import { ENTITY_LEVELS } from './columns.js';
import type { EntityLevel } from './columns.js';
import { isGridDensity } from './density.js';
import type { GridDensity } from './density.js';
import type { FilterSet } from './filter.js';
import type { SortRule } from './sort.js';

export interface DateRange {
  start: string;
  end: string;
}

export interface SavedView {
  id: string;
  name: string;
  entity: EntityLevel;
  /** Visible column ids, in display order. Order is the layout. */
  columns: readonly string[];
  /** Column ids pinned left of the pin line. */
  pinned: readonly string[];
  /** Per-column width overrides, keyed by column id. */
  widths: Readonly<Record<string, number>>;
  /**
   * Row density. Absent on layouts written before it existed, which render at
   * the normal density they were designed against.
   */
  density?: GridDensity;
  filter: FilterSet;
  sort: readonly SortRule[];
  /** Unique dimension ids in outermost-to-innermost hierarchy order. */
  groupBy: readonly string[];
  /**
   * Null means "whatever the page is showing". A view that pins a date range is
   * a report; a view that does not is a lens. Both are useful and they are not
   * the same object, so the difference is explicit.
   */
  dateRange: DateRange | null;
  updatedAt: string;
}

export interface ViewStore {
  list(entity: EntityLevel): Promise<SavedView[]>;
  save(view: SavedView): Promise<void>;
  remove(id: string): Promise<void>;
  /** The layout to restore on load, per entity level. AdLabs' implicit memory. */
  lastLayout(entity: EntityLevel): Promise<SavedView | null>;
  rememberLayout(view: SavedView): Promise<void>;
}

/**
 * The part of a store that can answer "which layout was this operator using"
 * with no round trip at all.
 *
 * `ViewStore` is asynchronous because the shared, org-scoped, database-backed
 * store this port exists for will be, and that stays true. But browser storage
 * *is* synchronous, and paying a microtask — and a render of "Restoring your
 * saved grid layout…" — for a value already in memory delays the first thing
 * the operator sees for nothing. A store that can answer immediately says so by
 * implementing this; one that cannot simply does not, and the asynchronous path
 * is unchanged for it.
 *
 * It is an optional capability rather than a required method precisely so that
 * a remote store is not forced to invent a synchronous lie.
 */
export interface SynchronousLayoutSource {
  /** The remembered layout, or null when there is none and when the answer costs I/O. */
  cachedLayout(entity: EntityLevel): SavedView | null;
}

/** Does this store answer `cachedLayout` without waiting? */
export function hasCachedLayout(
  store: ViewStore | null | undefined,
): store is ViewStore & SynchronousLayoutSource {
  return typeof (store as Partial<SynchronousLayoutSource> | null | undefined)?.cachedLayout
    === 'function';
}

export const DEFAULT_LAYOUT_WRITE_DELAY_MS = 200;

/**
 * Persist a layout without writing once per mouse move.
 *
 * Dragging a column edge produces a `mousemove` stream, and the grid's layout
 * state changes on every one of them. Serialising the whole view and handing it
 * to storage that many times is work the operator paid for in dropped frames,
 * and every write but the last is discarded by the next one anyway.
 *
 * Leading edge plus trailing edge, deliberately: the first change of a gesture
 * lands immediately, so a single click — a sort, a density change — is
 * persisted at once and a reader that looks straight after it sees the truth.
 * Everything inside the window collapses into one trailing write. `flush()`
 * exists because the last state of a gesture must never be the one that is
 * dropped: the caller flushes when the scope changes and when it unmounts.
 */
export class LayoutWriteBuffer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: SavedView | null = null;

  constructor(
    private readonly store: ViewStore,
    private readonly delayMs: number = DEFAULT_LAYOUT_WRITE_DELAY_MS,
  ) {}

  remember(view: SavedView): void {
    if (this.timer === null) {
      this.write(view);
      this.open();
      return;
    }
    this.pending = view;
  }

  /** Write whatever is queued now. Safe to call when nothing is queued. */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const queued = this.pending;
    this.pending = null;
    if (queued !== null) this.write(queued);
  }

  private open(): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      const queued = this.pending;
      this.pending = null;
      if (queued === null) return;
      this.write(queued);
      this.open();
    }, this.delayMs);
  }

  private write(view: SavedView): void {
    // A layout is a preference. A store that rejects must not surface as an
    // unhandled rejection in the middle of a resize.
    void Promise.resolve(this.store.rememberLayout(view)).catch(() => {});
  }
}

export function newViewId(): string {
  return `view_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

export class MemoryViewStore implements ViewStore {
  private readonly views = new Map<string, SavedView>();
  private readonly layouts = new Map<EntityLevel, SavedView>();

  async list(entity: EntityLevel): Promise<SavedView[]> {
    return [...this.views.values()]
      .filter((view) => view.entity === entity)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async save(view: SavedView): Promise<void> {
    this.views.set(view.id, view);
  }

  async remove(id: string): Promise<void> {
    this.views.delete(id);
  }

  async lastLayout(entity: EntityLevel): Promise<SavedView | null> {
    return this.layouts.get(entity) ?? null;
  }

  async rememberLayout(view: SavedView): Promise<void> {
    this.layouts.set(view.entity, view);
  }
}

const NAMED_KEY = 'wizard-ads:views:v1';
const LAYOUT_KEY = 'wizard-ads:layout:v1';
const FILTER_OPERATORS = new Set([
  '>', '<', '>=', '<=', '=', '<>', 'IN', 'NOT_IN', 'LIKE', 'NOT_LIKE', 'IS_NULL', 'IS_NOT_NULL',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isFilterSet(value: unknown): value is FilterSet {
  if (!isRecord(value) || !Array.isArray(value['groups'])) return false;
  return value['groups'].every((group) => {
    if (!isRecord(group) || !Array.isArray(group['filters'])) return false;
    return group['filters'].every((filter) => {
      if (!isRecord(filter) || typeof filter['key'] !== 'string' || !Array.isArray(filter['conditions'])) {
        return false;
      }
      if (
        filter['logical_operator'] !== undefined &&
        filter['logical_operator'] !== 'AND' &&
        filter['logical_operator'] !== 'OR'
      ) {
        return false;
      }
      return filter['conditions'].every((condition) =>
        isRecord(condition) &&
        isStringArray(condition['values']) &&
        (condition['operator'] === undefined || FILTER_OPERATORS.has(String(condition['operator']))),
      );
    });
  });
}

function isSavedView(value: unknown): value is SavedView {
  if (!isRecord(value)) return false;
  const widths = value['widths'];
  const sort = value['sort'];
  const dateRange = value['dateRange'];
  return (
    typeof value['id'] === 'string' &&
    typeof value['name'] === 'string' &&
    ENTITY_LEVELS.includes(value['entity'] as EntityLevel) &&
    isStringArray(value['columns']) &&
    isStringArray(value['pinned']) &&
    isRecord(widths) &&
    Object.values(widths).every((width) => typeof width === 'number' && Number.isFinite(width)) &&
    (value['density'] === undefined || isGridDensity(value['density'])) &&
    isFilterSet(value['filter']) &&
    Array.isArray(sort) &&
    sort.every((rule) =>
      isRecord(rule) &&
      typeof rule['columnId'] === 'string' &&
      (rule['direction'] === 'asc' || rule['direction'] === 'desc'),
    ) &&
    isStringArray(value['groupBy']) &&
    (dateRange === null ||
      (isRecord(dateRange) && typeof dateRange['start'] === 'string' && typeof dateRange['end'] === 'string')) &&
    typeof value['updatedAt'] === 'string'
  );
}

/** Minimal shape of `window.localStorage`, so this file needs no DOM lib at rest. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Browser-backed store.
 *
 * Reads are defensive: a corrupt or half-written entry yields "no saved views"
 * rather than an exception, because a bad JSON blob in a user's browser must
 * never be able to blank the grid. It is a cache of a preference, not data.
 */
export class LocalViewStore implements ViewStore, SynchronousLayoutSource {
  constructor(private readonly storage: KeyValueStorage) {}

  private readRecord(key: string): Record<string, unknown> {
    try {
      const raw = this.storage.getItem(key);
      if (raw === null) return {};
      const parsed: unknown = JSON.parse(raw);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  private readViews(key: string): Record<string, SavedView> {
    const valid: Record<string, SavedView> = {};
    for (const [id, candidate] of Object.entries(this.readRecord(key))) {
      if (isSavedView(candidate)) valid[id] = candidate;
    }
    return valid;
  }

  private write(key: string, value: unknown): void {
    try {
      this.storage.setItem(key, JSON.stringify(value));
    } catch {
      // Quota, private mode, a disabled storage API: losing a layout preference
      // is not worth breaking a render over.
    }
  }

  async list(entity: EntityLevel): Promise<SavedView[]> {
    const all = this.readViews(NAMED_KEY);
    return Object.values(all)
      .filter((view) => view.entity === entity)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async save(view: SavedView): Promise<void> {
    const all = this.readViews(NAMED_KEY);
    all[view.id] = view;
    this.write(NAMED_KEY, all);
  }

  async remove(id: string): Promise<void> {
    const all = this.readViews(NAMED_KEY);
    delete all[id];
    this.write(NAMED_KEY, all);
  }

  async lastLayout(entity: EntityLevel): Promise<SavedView | null> {
    return this.cachedLayout(entity);
  }

  /**
   * The same answer as `lastLayout`, without the promise.
   *
   * `localStorage` is a synchronous API, so this is the read that was always
   * happening; the promise around it only ever deferred the render that needed
   * it. Every defence in `lastLayout` is kept — a corrupt or half-written entry
   * yields "no layout" rather than an exception, and a layout stored under the
   * wrong entity is refused — because a bad blob in one browser must never be
   * able to blank the grid.
   */
  cachedLayout(entity: EntityLevel): SavedView | null {
    const candidate = this.readRecord(LAYOUT_KEY)[entity];
    return isSavedView(candidate) && candidate.entity === entity ? candidate : null;
  }

  async rememberLayout(view: SavedView): Promise<void> {
    const all = this.readViews(LAYOUT_KEY);
    all[view.entity] = view;
    this.write(LAYOUT_KEY, all);
  }
}
