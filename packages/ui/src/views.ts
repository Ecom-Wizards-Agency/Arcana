/**
 * Saved views: columns + filters + sort + group-by + date range, named.
 *
 * The recon (`https://github.com/Ecom-Wizards-Agency/openspell/blob/dd4f3887f626128250abee537f374712ca42717c/tools/recon/02-data-grid.md` §5) found that AdLabs has *one implicit
 * remembered layout per user* -- no named presets, no per-view filter sets, no
 * sharing. Its verdict, and ours: clone the auto-persisted layout, beat it with
 * named views that bundle the lens rather than the result.
 *
 * A view is a **lens**, and that word is load-bearing: it deliberately carries
 * no profile id. "My Monday pacing view" is worth having precisely because it
 * applies to any of the profiles an agency runs; binding it to one would make
 * it fifteen views that drift apart, which is the exact failure the recon
 * records in AdLabs' dashboard duplication model (`https://github.com/Ecom-Wizards-Agency/openspell/blob/dd4f3887f626128250abee537f374712ca42717c/tools/recon/03-dashboards.md` §6).
 *
 * ## Storage
 *
 * `ViewStore` has memory, browser and database-backed implementations. The
 * database transport is injected by the application. Browser caches require
 * both user and agency identity; origin storage alone is shared across accounts.
 */
import { GridSavedView, OrgActor } from '@wizard-ads/shared';
import { ENTITY_LEVELS } from './columns.js';
import type { EntityLevel } from './columns.js';

export interface DateRange {
  start: string;
  end: string;
}

export type SavedView = GridSavedView;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSavedView(value: unknown): value is SavedView {
  return GridSavedView.safeParse(value).success;
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
  private readonly namedKey: string;
  private readonly layoutKey: string;

  constructor(private readonly storage: KeyValueStorage, rawActor: Readonly<OrgActor>) {
    const actor = OrgActor.parse(rawActor);
    // UUID validation makes the separators unambiguous. Derive immutable keys
    // once, so a delayed write always belongs to the store's original owner.
    const scope = `${actor.orgId}:${actor.userId}`;
    this.namedKey = `wizard-ads:views:v2:${scope}`;
    this.layoutKey = `wizard-ads:layout:v2:${scope}`;
    // Ownerless v1 keys are deliberately left unread and unchanged. Assigning
    // them to the next signer would disclose the previous agency's filters.
  }

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
    const all = this.readViews(this.namedKey);
    return Object.values(all)
      .filter((view) => view.entity === entity)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async save(view: SavedView): Promise<void> {
    const all = this.readViews(this.namedKey);
    all[view.id] = view;
    this.write(this.namedKey, all);
  }

  async remove(id: string): Promise<void> {
    const all = this.readViews(this.namedKey);
    delete all[id];
    this.write(this.namedKey, all);
  }

  /** Upload receipts are scoped like the cache and compare the exact document. */
  async pendingViews(): Promise<SavedView[]> {
    const receipts = this.readRecord(`${this.namedKey}:uploaded`);
    return Object.values(this.readViews(this.namedKey)).filter((view) => receipts[view.id] !== JSON.stringify(view));
  }

  markUploaded(views: readonly SavedView[]): void {
    const receipts = this.readRecord(`${this.namedKey}:uploaded`);
    for (const view of views) receipts[view.id] = JSON.stringify(view);
    this.write(`${this.namedKey}:uploaded`, receipts);
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
    const candidate = this.readRecord(this.layoutKey)[entity];
    return isSavedView(candidate) && candidate.entity === entity ? candidate : null;
  }

  async rememberLayout(view: SavedView): Promise<void> {
    const all = this.readViews(this.layoutKey);
    all[view.entity] = view;
    this.write(this.layoutKey, all);
  }
}

/** Network operations are injected so the UI package has no application dependency. */
export interface GridViewTransport {
  list(entity: EntityLevel): Promise<SavedView[]>;
  save(views: readonly SavedView[]): Promise<number>;
  remove(id: string): Promise<void>;
}

/** Named views in the agency database; browser layouts remain a synchronous cache. */
export class DbViewStore implements ViewStore, SynchronousLayoutSource {
  private migrated = false;
  constructor(private readonly remote: GridViewTransport, private readonly local: ViewStore & SynchronousLayoutSource & {
    pendingViews?: () => Promise<SavedView[]>;
    markUploaded?: (views: readonly SavedView[]) => void;
  }) {}
  cachedLayout(entity: EntityLevel): SavedView | null { return this.local.cachedLayout(entity); }
  lastLayout(entity: EntityLevel): Promise<SavedView | null> { return this.local.lastLayout(entity); }
  rememberLayout(view: SavedView): Promise<void> { return this.local.rememberLayout(view); }
  async list(entity: EntityLevel): Promise<SavedView[]> {
    try { return await this.remote.list(entity); }
    catch (error) { if (!(error instanceof TypeError)) throw error; return this.local.list(entity); }
  }
  async save(view: SavedView): Promise<void> {
    const legacy = this.local.pendingViews !== undefined
      ? await this.local.pendingViews()
      : this.migrated ? [] : (await Promise.all(ENTITY_LEVELS.map((entity) => this.local.list(entity)))).flat();
    const views = [...new Map([...legacy, view].map((entry) => [entry.id, entry])).values()];
    let uploaded = false;
    try {
      if (await this.remote.save(views) !== views.length) throw new Error('View save count mismatch');
      this.migrated = true;
      uploaded = true;
    } catch (error) { if (!(error instanceof TypeError)) throw error; }
    await this.local.save(view);
    if (uploaded) this.local.markUploaded?.(views);
  }
  async remove(id: string): Promise<void> {
    try { await this.remote.remove(id); }
    catch (error) { if (!(error instanceof TypeError)) throw error; }
    await this.local.remove(id);
  }
}
