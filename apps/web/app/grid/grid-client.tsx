'use client';

/**
 * The grid workspace: everything interactive on `/grid`.
 *
 * One piece of state, `view`, holds columns, pinning, widths, filters, sort and
 * group-by — the same object a saved view stores and a deep link would restore.
 * There is no separate "toolbar state", which is what makes "share this lens"
 * a two-line feature rather than a refactor.
 *
 * The pipeline runs inside a `useMemo` keyed on the rows and the view, so
 * typing in a filter box re-runs filter → group → sort → total once per
 * keystroke over the whole set. The 50k perf suite is what says that is
 * affordable; without it this component would be a guess.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { TargetDrawerProvider } from '../../src/screens/targets/drawer-trigger';
import { SelectAllMatched, SelectRowCheckbox, TargetingCell } from '../../src/screens/grid/table-cells';
import { useRouter, useSearchParams } from 'next/navigation';
import { gridWork } from '../../src/screens/grid/performance-timing';
import type { ReactNode } from 'react';
import { decodeGridRowColumns, decodeGridPerformance, type GridPerformanceEvidence, GridMeasurement, PerformanceVerdict, parseGridView, serializeGridView, type OrgActor } from '@wizard-ads/shared';
import { browserViewStore } from './view-store';
import {
  DataGrid, NumericValue,
  DEFAULT_DENSITY,
  BASE_METRICS,
  GridViewport,
  LayoutWriteBuffer,
  STATE_COLUMN,
  columnsFor,
  defaultVisibleColumns,
  formatInteger,
  hasCachedLayout,
  newViewId,
  resolveField,
  toCsv,
} from '@wizard-ads/ui';
import type {
  EntityLevel,
  FilterSet,
  FreshnessAssessment,
  GridColumn,
  GridDensity,
  GridRow,
  SavedView,
  SortRule,
  ViewStore,
} from '@wizard-ads/ui';
import { FreshnessBanner, tokens } from '@wizard-ads/ui';
import { buildPerformanceModel, scopeRows } from '../../src/screens/grid/performance-model';
import type { GridPayload } from '../_lib/grid-data';
import { PerformanceSummary, PerformanceToolbar } from '../../src/screens/grid/performance-chrome';
import { useTranslationColumn } from '../../src/screens/grid/translation-column';

interface GridWorkspaceBaseProps {
  /** Identity supplied by the authenticated server page, never an API override. */
  actor: Readonly<OrgActor>;
  entity: EntityLevel;
  currencyCode: string;
  profileId: string;
  period: { start: string; end: string };
  comparisonPeriod: { start: string; end: string };
  /** Streamed server-owned crosscheck state; it never blocks the data grid. */
  crosscheck?: ReactNode;
  /** Campaign deep-link applied as a visible grid filter. */
  campaignId: string | null;
  asin?: string | null;
  /** Test seam for proving delayed restoration. Production uses browser localStorage. */
  viewStore?: ViewStore | null;
}

/** Streamed React content is opaque: it may arrive as a lazy RSC reference. */
export type GridWorkspaceProps = GridWorkspaceBaseProps & (
  | { freshness: FreshnessAssessment; freshnessContent?: never }
  | { freshnessContent: ReactNode; freshness?: never }
);

type ReadyGridWorkspaceProps = GridWorkspaceProps & {
  rows: readonly GridRow[];
  performance?: GridPerformanceEvidence;
};

type GridLoadState =
  | { status: 'loading'; scope: string }
  | { status: 'ready'; scope: string; payload: GridPayload }
  | { status: 'error'; scope: string };

interface InFlightGridRequest {
  scope: string;
  controller: AbortController;
  promise: Promise<GridPayload>;
  settled: boolean;
  abortTimer: ReturnType<typeof setTimeout> | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTotals(value: unknown): value is GridRow['totals'] {
  return (
    isRecord(value) &&
    BASE_METRICS.every((metric) =>
      typeof value[metric] === 'number' && Number.isFinite(value[metric]),
    )
  );
}

function isGridRow(value: unknown): value is GridRow {
  if (!isRecord(value) || typeof value['id'] !== 'string') return false;
  if (typeof value['currencyCode'] !== 'string' || !isRecord(value['dimensions'])) return false;
  if (!Object.values(value['dimensions']).every((dimension) =>
    dimension === null || ['string', 'number', 'boolean'].includes(typeof dimension),
  )) return false;
  if (value['measurement'] !== undefined && !GridMeasurement.safeParse(value['measurement']).success) return false;
  if (!isTotals(value['totals'])) return false;
  if (value['comparison'] !== null && !isTotals(value['comparison'])) return false;
  const tagIds = value['tagIds'];
  return tagIds === undefined || (Array.isArray(tagIds) && tagIds.every((tag) => typeof tag === 'string'));
}

/** Refuse partial or malformed transport data before it becomes actionable. */
export function parseGridRowsPayload(value: unknown): GridPayload {
  const columnar = isRecord(value) && value['rowColumns'] !== undefined;
  if (columnar && isRecord(value)) {
    if (value['rows'] !== undefined) throw new Error('Grid response has ambiguous row encodings');
    value = { ...value, rows: decodeGridRowColumns(value['rowColumns']) };
  }
  if (!isRecord(value) || !Array.isArray(value['rows'])) {
    throw new Error('Grid response does not contain rows');
  }
  if (typeof value['truncated'] !== 'boolean') {
    throw new Error('Grid response does not declare truncation');
  }
  if (!Number.isInteger(value['rowCount']) || Number(value['rowCount']) < 0) {
    throw new Error('Grid response does not contain a valid row count');
  }
  if (Number(value['rowCount']) !== value['rows'].length) {
    throw new Error('Grid response row count does not match its rows');
  }
  // Column decoding has already validated every field through the shared contract.
  if (!columnar && !value['rows'].every(isGridRow)) throw new Error('Grid response contains an invalid row');
  return {
    rows: value['rows'] as GridRow[],
    rowCount: Number(value['rowCount']),
    truncated: value['truncated'],
    ...(value['performance'] === undefined ? {} : { performance: decodeGridPerformance(value['performance']) }),
  };
}

export function gridRowsRequestUrl(
  props: Pick<GridWorkspaceProps, 'profileId' | 'entity' | 'period'> & Partial<Pick<GridWorkspaceProps, 'comparisonPeriod'>>,
): string {
  const query = new URLSearchParams({
    profile: props.profileId,
    entity: props.entity,
    from: props.period.start,
    to: props.period.end,
  });
  if (props.comparisonPeriod) {
    query.set('compareFrom', props.comparisonPeriod.start);
    query.set('compareTo', props.comparisonPeriod.end);
  }
  return `/api/grid/rows?${query.toString()}`;
}

function startGridRequest(scope: string): InFlightGridRequest {
  const controller = new AbortController();
  const promise = fetch(scope, {
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    signal: controller.signal,
  }).then(async (response) => {
    if (!response.ok) throw new Error(`Grid request failed with ${response.status}`);
    const jsonStart = performance.now();
    const body = await response.json();
    if ((globalThis as { __gridProfile?: boolean }).__gridProfile) performance.measure('grid.json', { start: jsonStart });
    return gridWork('decode', () => parseGridRowsPayload(body));
  });
  const request: InFlightGridRequest = {
    scope,
    controller,
    promise,
    settled: false,
    abortTimer: null,
  };
  void promise.then(
    () => { request.settled = true; },
    () => { request.settled = true; },
  );
  return request;
}

/**
 * The default view, matching AdLabs' enabled-only default — but as a *visible*
 * filter chip rather than a hidden server-side exclusion.
 *
 * The recon's sharpest finding about that default (`https://github.com/Ecom-Wizards-Agency/Arcana/blob/dd4f3887f626128250abee537f374712ca42717c/tools/recon/02-data-grid.md` §3): their
 * campaign entity returns only ENABLED and PAUSED, never ARCHIVED, so a month
 * total silently excludes archived spend and will not reconcile against Amazon.
 * Ours applies the same default and shows it, so removing it is one click and
 * the exclusion is never invisible.
 */
function defaultView(entity: EntityLevel, campaignId: string | null): SavedView {
  const stateColumn = STATE_COLUMN[entity];
  const filter: FilterSet =
    campaignId !== null && entity === 'campaigns'
      ? {
          groups: [
            {
              filters: [
                {
                  key: 'CAMPAIGN_ID',
                  conditions: [{ operator: '=', values: [campaignId] }],
                },
              ],
            },
          ],
        }
      : stateColumn === undefined
      ? { groups: [] }
      : {
          groups: [
            {
              filters: [
                {
                  key: stateColumn.toUpperCase(),
                  conditions: [{ operator: 'IN', values: ['enabled'] }],
                },
              ],
            },
          ],
        };

  return {
    id: 'default',
    name: 'Default',
    entity,
    columns: defaultVisibleColumns(entity),
    pinned: columnsFor(entity).filter((column) => column.pinned).map((column) => column.id),
    widths: {},
    filter,
    sort: [{ columnId: 'spend', direction: 'desc' }],
    groupBy: [],
    dateRange: null,
    updatedAt: new Date().toISOString(),
  };
}

/** How each entity level's rows map into an experiment's scope. */
/** Stable first-seen scope with a hard URL-size bound and no full-array pipeline. */
export function experimentScopeIds(rows: readonly GridRow[], key: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const value = row.dimensions[key];
    if (value === null || value === undefined) continue;
    const id = String(value);
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length === 100) break;
  }
  return ids;
}

export function gridExperimentHref(profileId: string, entity: EntityLevel, rows: readonly GridRow[]): string {
  const experimentScope = ({ campaigns: ['campaigns', 'campaign_id'], ad_groups: ['adgroups', 'ad_group_id'], targets: ['targets', 'target_id'], search_terms: ['terms', 'search_term'], products: ['asins', 'asin'], placements: ['campaigns', 'campaign_id'] } as const)[entity];
  return `/experiments/new?${new URLSearchParams({ profile: profileId, [experimentScope[0]]: experimentScopeIds(rows, experimentScope[1]).join(',') })}`;
}

export function GridWorkspace(props: GridWorkspaceProps): ReactNode {
  // Identity replacement owns the entire hook subtree: rows, late requests,
  // saved views, selections and buffered writes. Callers need no special key.
  return <ScopedGridWorkspace key={JSON.stringify([props.actor.userId, props.actor.orgId, props.asin ?? null])} {...props} />;
}

function ScopedGridWorkspace(props: GridWorkspaceProps): ReactNode {
  const scope = gridRowsRequestUrl(props);
  const generation = useRef(0);
  const activeRequest = useRef<InFlightGridRequest | null>(null);
  const [retry, setRetry] = useState(0);
  const [load, setLoad] = useState<GridLoadState>({ status: 'loading', scope });

  // Start the counted read as soon as this island commits, before the browser
  // waits for a paint and unrelated passive effects. Cleanup/replay stays scoped.
  useLayoutEffect(() => {
    const requestGeneration = ++generation.current;
    setLoad({ status: 'loading', scope });
    let request = activeRequest.current;
    if (request === null || request.scope !== scope || request.settled) {
      request = startGridRequest(scope);
      activeRequest.current = request;
    } else if (request.abortTimer !== null) {
      clearTimeout(request.abortTimer);
      request.abortTimer = null;
    }

    void request.promise
      .then((payload) => {
        if (!request.controller.signal.aborted && generation.current === requestGeneration) {
          setLoad({ status: 'ready', scope, payload });
        }
      })
      .catch((error: unknown) => {
        if (request.controller.signal.aborted || generation.current !== requestGeneration) return;
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setLoad({ status: 'error', scope });
      });

    return () => {
      generation.current++;
      if (request.settled) return;
      // React development Strict Mode immediately re-runs an effect after its
      // cleanup. Give that same-scope run one task to reclaim the in-flight
      // request; a real unmount or scope change leaves the timer in place and
      // aborts it. This keeps one network request per settled Grid scope.
      request.abortTimer = setTimeout(() => request.controller.abort(), 0);
    };
  }, [retry, scope]);

  // A prop change renders before its effect runs. Treat a state object from the
  // previous scope as loading immediately so stale tenant or period rows never
  // flash while React schedules the replacement request.
  const current: GridLoadState = load.scope === scope ? load : { status: 'loading', scope };

  return (
    <div className="wa-embed" style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      {props.freshness === undefined ? props.freshnessContent : (
        <FreshnessBanner assessment={props.freshness}>
          {props.crosscheck ?? null}
        </FreshnessBanner>
      )}

      {current.status === 'loading' ? (
        <section
          aria-busy="true"
          aria-live="polite"
          className="wa-card"
          data-testid="grid-data-loading"
          style={loadPanelStyle}
        >
          <strong>Loading the complete result set…</strong>
          <span style={{ color: tokens.color.textMuted }}>
            Filters, grouping, totals, and export become available together.
          </span>
        </section>
      ) : current.status === 'error' ? (
        <section role="alert" className="wa-card" data-testid="grid-data-error" style={loadPanelStyle}>
          <strong>Grid data could not be loaded.</strong>
          <span style={{ color: tokens.color.textMuted }}>
            No partial rows are shown. Check the connection and try again.
          </span>
          <div>
            <button
              type="button"
              className="wa-btn wa-btn--sm"
              onClick={() => {
                setLoad({ status: 'loading', scope });
                setRetry((currentRetry) => currentRetry + 1);
              }}
            >
              Retry
            </button>
          </div>
        </section>
      ) : (
        <>
          <p className="wa-sr-only" role="status" data-testid="grid-row-count">
            {current.payload.truncated ? 'Partial' : 'Complete'} result set loaded:{' '}
            {formatInteger(current.payload.rowCount)} rows.
          </p>
          {current.payload.truncated ? (
            <p style={{ ...filterErrorStyle, margin: 0 }}>
              This result is too large to load safely. The set below is truncated to{' '}
              {formatInteger(current.payload.rowCount)} rows, and its totals cover only what is
              shown. Narrow the period or entity level for a complete read.
            </p>
          ) : null}
          <ReadyGridWorkspace {...props} rows={current.payload.rows} performance={current.payload.performance} />
        </>
      )}
    </div>
  );
}

/**
 * The remembered layout, if the store can produce it without waiting.
 *
 * A campaign deep link is never restored over: `?campaign=` names the scope the
 * operator asked for, so it opens on its own defaults exactly as it did before.
 */
function cachedLayoutFor(
  store: ViewStore | null,
  entity: EntityLevel,
  campaignId: string | null,
  available: readonly GridColumn[],
): SavedView | null {
  const urlView = typeof window === 'undefined' ? null : parseGridView(new URL(window.location.href).searchParams.get('view'));
  if (urlView?.entity === entity) return withValidGrouping(urlView, available);
  if (campaignId !== null || !hasCachedLayout(store)) return null;
  try {
    const layout = store.cachedLayout(entity);
    return layout === null
      ? null
      : withValidGrouping({ ...layout, id: 'default', name: 'Default' }, available);
  } catch {
    // Browser storage is a preference cache; a throwing one restores nothing.
    return null;
  }
}

/** The grid's floor once the cockpit is above it. See the `GridViewport` below. */
const GRID_MIN_HEIGHT = 662;

function ReadyGridWorkspace(props: ReadyGridWorkspaceProps): ReactNode {
  const router = useRouter();
  const available = useMemo(() => columnsFor(props.entity), [props.entity]);
  const [browserStore] = useState(() =>
    typeof window === 'undefined' ? null : browserViewStore(props.actor, props.profileId),
  );
  const store = props.viewStore === undefined ? browserStore : props.viewStore;
  const scopeKey = `${props.entity}\u0000${props.campaignId ?? ''}`;
  /**
   * First paint, before any await.
   *
   * This subtree is not part of hydration: it renders only once the client's
   * own `/api/grid/rows` request has resolved, so the server HTML never
   * contains a grid whose layout could disagree with the browser's. That is
   * what makes reading storage in a state initializer safe here, and the read
   * is guarded on the store advertising `cachedLayout` so a remote or
   * deliberately asynchronous store keeps the exact behaviour it had.
   */
  const [initialRestore] = useState(() => {
    const cached = cachedLayoutFor(store, props.entity, props.campaignId, available);
    return {
      scopeKey,
      restored: cached !== null,
      view: cached ?? defaultView(props.entity, props.campaignId),
    };
  });
  const [view, setView] = useState<SavedView>(initialRestore.view);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<readonly SavedView[]>([]);
  const [restoredScope, setRestoredScope] = useState<{
    key: string;
    store: ViewStore | null;
  } | null>(initialRestore.restored ? { key: initialRestore.scopeKey, store } : null);
  // The scope and store the last synchronous read answered for, and whether it
  // produced a layout. The asynchronous restoration must not overwrite a
  // successful one, because by the time it lands the operator may have moved a
  // column — but the whole record is stale the moment either half changes, so
  // it records the scope it was taken in rather than only its successes.
  const syncRestore = useRef<{ key: string; store: ViewStore | null; restored: boolean }>({
    key: initialRestore.scopeKey,
    store,
    restored: initialRestore.restored,
  });
  const [selectedRowIds, setSelectedRowIds] = useState<string[]>([]);
  const selectedRowSet = useMemo(() => new Set(selectedRowIds), [selectedRowIds]);
  const [fullscreen, setFullscreen] = useState(false);
  const searchParams = useSearchParams();
  const asinScope = searchParams.get('asin');
  const layoutWrites = useMemo(
    () => (store === null ? null : new LayoutWriteBuffer(store)),
    [store],
  );
  // The last state of a gesture is the one worth keeping, so a scope change or
  // an unmount writes whatever the debounce is still holding.
  useEffect(() => () => layoutWrites?.flush(), [layoutWrites]);
  // Readiness belongs to the exact entity/deep-link scope that was restored.
  // Deriving it from the current props prevents one render of stale `true`
  // before an effect can reset a boolean after a client-side route change.
  const viewReady = restoredScope?.key === scopeKey && restoredScope.store === store;

  useEffect(() => {
    if (!viewReady) return;
    const url = new URL(window.location.href);
    url.searchParams.set('view', serializeGridView(view));
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }, [view, viewReady]);

  // Target drawers preserve their namespaced state in the same view envelope.
  useEffect(() => {
    const receive = (event: Event) => {
      if (!(event instanceof CustomEvent) || typeof event.detail !== 'string') return;
      const incoming = parseGridView(event.detail);
      if (!incoming || incoming.entity !== props.entity) return;
      setView((current) => ({ ...current,
        ...(incoming.target === undefined ? {} : { target: incoming.target }),
        ...(incoming.compare === undefined ? {} : { compare: incoming.compare }),
      }));
    };
    window.addEventListener('arcana:target-view', receive);
    return () => window.removeEventListener('arcana:target-view', receive);
  }, [props.entity]);

  // Restore the implicit layout AdLabs remembers per user, and list the named
  // views we have that they do not.
  useEffect(() => {
    if (store === null) {
      setView(cachedLayoutFor(null, props.entity, props.campaignId, available) ?? defaultView(props.entity, props.campaignId));
      setSaved([]);
      setSelectedRowIds([]);
      setRestoredScope({ key: scopeKey, store });
      return;
    }
    let cancelled = false;

    // A client-side entity switch or a campaign deep link remounts nothing, so
    // the synchronous read happens here as well as in the state initializer
    // above — the operator who moves from campaigns to targets should not wait
    // either. Every scope change is read again, including a return to a scope
    // restored earlier: a remembered success from before the deep link says
    // nothing about the view now on screen, which is the deep link's.
    let restoredSynchronously =
      syncRestore.current.restored
      && syncRestore.current.key === scopeKey
      && syncRestore.current.store === store;
    if (syncRestore.current.key !== scopeKey || syncRestore.current.store !== store) {
      const cached = cachedLayoutFor(store, props.entity, props.campaignId, available);
      syncRestore.current = { key: scopeKey, store, restored: cached !== null };
      restoredSynchronously = cached !== null;
      if (cached !== null) {
        setView(cached);
          setSelectedRowIds([]);
        setRestoredScope({ key: scopeKey, store });
      }
    }

    void (async () => {
      try {
        const [layout, list] = await Promise.all([
          // Nothing to ask for: this scope already has its layout, and asking
          // again could only produce an answer that arrives after the operator
          // has started working and overwrites what they did.
          restoredSynchronously
            ? Promise.resolve<SavedView | null>(null)
            : store.lastLayout(props.entity),
          store.list(props.entity),
        ]);
        if (cancelled) return;
        if (!restoredSynchronously) {
          if (props.campaignId !== null) setView(defaultView(props.entity, props.campaignId));
          else if (layout !== null) {
            setView(withValidGrouping({ ...layout, id: 'default', name: 'Default' }, available));
          }
          else setView(defaultView(props.entity, null));
        }
        setSaved(list);
      } catch {
        if (cancelled) return;
        // Browser storage is a preference cache. A rejected custom/remote
        // store must not strand the analytical grid behind a permanent loader.
        if (!restoredSynchronously) setView(defaultView(props.entity, props.campaignId));
        setSaved([]);
      }
      if (!restoredSynchronously) {
          setSelectedRowIds([]);
      }
      // This is deliberately later than hydration alone. An interaction that
      // lands after React attaches but before the saved layout resolves can be
      // overwritten by the restoration above just as surely as a pre-hydration
      // interaction can be lost. The restored scope opens only the matching
      // entity/deep-link workspace, never a later render with different props.
      setRestoredScope((current) =>
        current?.key === scopeKey && current.store === store
          ? current
          : { key: scopeKey, store },
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [available, props.campaignId, props.entity, scopeKey, store]);

  const update = useCallback(
    (patch: Partial<SavedView>) => {
      if (!viewReady) return;
      setView((current) => {
        const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
        // Debounced: a column resize changes this state on every mouse move and
        // every write but the last is thrown away by the next one. The buffer
        // writes the first change of a gesture immediately and collapses the
        // rest, and flushes when the scope changes or the workspace unmounts.
        layoutWrites?.remember(next);
        return next;
      });
    },
    [layoutWrites, viewReady],
  );

  const comparisonDisabled = useSearchParams().get('comparison') === 'none';
  const scopedRows = useMemo(() => {
    const rows = scopeRows(props.rows, asinScope);
    return comparisonDisabled ? rows.map((row) => ({ ...row, comparison: null })) : rows;
  }, [props.rows, asinScope, comparisonDisabled]);
  const { model, filterError } = useMemo(
    () => gridWork('model', () => buildPerformanceModel(scopedRows, { filter: view.filter, sort: view.sort, groupBy: view.groupBy })),
    [scopedRows, view.filter, view.sort, view.groupBy],
  );

  /**
   * Visible columns, in the operator's order.
   *
   * When a group-by is active the grouping dimensions lead and are pinned, in
   * hierarchy order, so the tree reads left to right; every other visible
   * column follows in the operator's order. The non-grouped dimensions render
   * blank on group rows (the aggregation legitimately dropped them), exactly
   * as AdLabs' grouped grid does -- and their headers stay on screen, which is
   * what makes "drop another header to nest" possible at all.
   */
  const visibleColumns = useMemo<GridColumn[]>(() => {
    const byId = new Map(available.map((column) => [column.id, column]));
    const baseWanted = [...view.columns];
    if (baseWanted.includes('translation')) { baseWanted.splice(baseWanted.indexOf('translation'), 1); baseWanted.splice(1, 0, 'translation'); }
    const wanted = model.grouped
      ? [...model.groupBy, ...baseWanted.filter((id) => !model.groupBy.includes(id))]
      : baseWanted;
    return wanted
      .map((id) => byId.get(id))
      .filter((column): column is GridColumn => column !== undefined)
      .map((column) => {
        const width = view.widths[column.id];
        const pinned = view.pinned.includes(column.id) || model.groupBy.includes(column.id);
        const normalHeaders: Record<string, string> = { sqp_impression_share: 'SQP IS', sqp_purchase_share: 'SQP purch', verdict: 'Diagnosis' };
        const header = props.entity === 'targets' && !view.columns.includes('rank_grid') ? normalHeaders[column.id] ?? column.header : column.header;
        return { ...column, header, align: view.alignments?.[column.id] ?? column.align, ...(width === undefined ? {} : { width }), pinned };
      });
  }, [available, model.groupBy, model.grouped, view.columns, view.pinned, view.widths, view.alignments, props.entity]);

  const density: GridDensity = view.density ?? DEFAULT_DENSITY;
  const translation = useTranslationColumn(props.profileId, view.translation?.language ?? 'en', viewReady && view.columns.includes('translation'), props.rows);
  const experimentHref = gridExperimentHref(props.profileId, props.entity, model.matchedRows);
  const matchedRowIds = useMemo(() => model.matchedRows.map((row) => row.id), [model.matchedRows]);
  const identityColumn = useMemo(() => available.find((column) => column.pinned), [available]);
  const backToGrid = useMemo(() => `/grid?${new URLSearchParams({ profile: props.profileId, entity: props.entity, from: props.period.start, to: props.period.end, compareFrom: props.comparisonPeriod.start, compareTo: props.comparisonPeriod.end, view: serializeGridView(view), ...(asinScope ? { asin: asinScope } : {}) })}`, [props.profileId, props.entity, props.period, props.comparisonPeriod, view, asinScope]);
  const rowHref = useCallback((row: GridRow) => {
    return `/targets/${encodeURIComponent(String(row.dimensions['target_id']))}?${new URLSearchParams({ profile: props.profileId, from: props.period.start, to: props.period.end, compareFrom: props.comparisonPeriod.start, compareTo: props.comparisonPeriod.end, back: backToGrid })}`;
  }, [props.profileId, props.period, props.comparisonPeriod, backToGrid]);
  const renderCells = useMemo(() => {
  const reason = (feed: 'PPC' | 'RANK' | 'SQP') => `${props.performance?.feeds.find((item) => item.feed === feed)?.reason ?? `${feed} not measured in this range.`} An empty cell means this target has no measured ${feed === 'PPC' ? 'top-of-search share' : feed === 'RANK' ? 'organic rank' : 'query evidence'} in the selected window.`;
  const number = (row: GridRow, key: string) => typeof row.dimensions[key] === 'number' ? row.dimensions[key] as number : null;
  return Object.fromEntries(available.map((column) => [column.id, (row: GridRow): ReactNode | undefined => {
    if (column.kind === 'metric' && resolveField(row, column.id) === null) return <DataGrid.cells.NotMeasuredCell reason={column.id.includes('comparison') || column.id.includes('delta') ? 'The comparison is not measured, or its denominator is unavailable.' : 'This metric is not measured, or its denominator is unavailable.'} />;
    if (column.id === 'translation') return translation.cell(row);
    if (column.id === 'suggested_bid' && props.entity === 'targets') {
      const value = number(row, 'suggested_bid');
      if (value === null) return <DataGrid.cells.NotMeasuredCell reason="The Amazon suggested-bid corridor is not measured for this ad group and theme." />;
      const money = (amount: number | null) => amount === null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: props.currencyCode }).format(amount);
      return <span data-testid="suggested-bid-cell" title={`Suggested bid corridor: ${money(number(row, 'suggested_bid_low'))} – ${money(number(row, 'suggested_bid_high'))}`}><NumericValue value={money(value)} /></span>;
    }
    if (column.id === 'gap' && row.dimensions['gap'] == null) return <DataGrid.cells.NotMeasuredCell label="Not measured" reason="Comparable competitor ranks are not measured on this date." />;
    if (column.id === 'gap') return <DataGrid.cells.DeltaCell value={number(row, 'gap')} better="higher" />;
    if (column.id === 'signals') return <DataGrid.cells.SignalsCell axes={[{ key: 'R', value: number(row, 'organic_rank'), reason: reason('RANK') }, { key: 'T', value: number(row, 'top_of_search_share'), reason: reason('PPC') }, { key: 'I', value: number(row, 'sqp_impression_share'), reason: reason('SQP') }, { key: 'P', value: number(row, 'sqp_purchase_share'), reason: reason('SQP') }]} />;
    if (column.id === 'rank_grid') return <DataGrid.cells.RankGridCell days={props.performance?.rankDays[row.id] ?? Array.from({ length: 14 }, (_, index) => ({ date: new Date(Date.parse(props.period.end) - (13 - index) * 86400000).toISOString().slice(0, 10), observed: false, rank: null }))} reason={reason('RANK')} />;
    if (column.id === 'verdict') return <DataGrid.cells.VerdictCell verdict={{ diagnosis: PerformanceVerdict.shape.diagnosis.safeParse(row.dimensions['verdict']).data ?? 'Insufficient evidence', reason: String(row.dimensions['verdict_reason'] ?? 'no threshold configured') }} />;
    if (column.id === 'rank_change' || column.id === 'acos_vs_target' || column.id === 'conversion_points') return <DataGrid.cells.DeltaCell value={number(row, column.id)} suffix={column.id === 'rank_change' ? '' : ' pts'} better={column.id === 'acos_vs_target' ? 'lower' : 'higher'} />;
    if (column.id === 'targeting' && props.entity === 'targets') return <TargetingCell row={row} href={rowHref(row)} />;
    if (row.dimensions[column.id] == null && column.kind === 'dimension' && column.subject !== 'Identity') return <DataGrid.cells.NotMeasuredCell reason={column.subject === 'BRAND ANALYTICS' ? 'Brand Analytics ingestion is not configured.' : reason(column.subject === 'SQP' ? 'SQP' : column.subject === 'RANK & ORGANIC' ? 'RANK' : 'PPC')} />;
    return undefined;
  }]));
  }, [available, props.entity, props.currencyCode, props.performance, props.period.end, rowHref, translation.cell]);

  const handleExport = useCallback(() => {
    if (!viewReady) return;
    const result = toCsv(model, {
      columns: visibleColumns,
      label: props.entity.replace('_', ' '),
      currencyCode: props.currencyCode,
      period: props.period,
      comparisonPeriod: props.comparisonPeriod,
    });
    downloadCsv(result.csv, result.filename);
  }, [model, props.comparisonPeriod, props.currencyCode, props.entity, props.period, viewReady, visibleColumns]);

  const handleSaveView = useCallback(
    (name: string) => {
      if (!viewReady || store === null) return;
      const toSave: SavedView = { ...view, groupBy: model.groupBy, id: newViewId(), name };
      setSaveError(null);
      void store.save(toSave).then(() => store.list(props.entity)).then(setSaved).catch(() => setSaveError('The view could not be saved. Try again.'));
    },
    [model.groupBy, props.entity, store, view, viewReady],
  );

  const handleRemoveView = useCallback(
    (removed: SavedView) => {
      if (!viewReady || store === null) return;
      setSaveError(null);
      void store.remove(removed.id).then(() => store.list(props.entity)).then(setSaved).catch(() => setSaveError('The view could not be removed.'));
    },
    [props.entity, store, viewReady],
  );

  const handleReorder = useCallback(
    (columnId: string, beforeColumnId: string | null) => {
      if (!viewReady) return;
      const remaining = view.columns.filter((id) => id !== columnId);
      const at = beforeColumnId === null ? remaining.length : remaining.indexOf(beforeColumnId);
      remaining.splice(at < 0 ? remaining.length : at, 0, columnId);
      update({ columns: remaining });
    },
    [update, view.columns, viewReady],
  );

  /**
   * "Start an experiment from this view" (WP-19): carry the ids of the currently
   * filtered rows into the new-experiment form, so the scope is pre-filled with
   * what the operator has selected in the grid. Additive — a link, not a change
   * to the grid or its model.
   */

  return (
    // `wa-embed` sets the inherited text colour and chromes the bare controls
    // WP-06 ships without an inline palette (inputs, selects, toolbar buttons).
    // The grid's own cells need nothing here: `packages/ui` writes
    // `var(--wa-*, <literal>)` and reads the tokens directly.
    /*
     * The measured fill resolves to this floor now that the tile row and the
     * trend chart sit above the grid: the viewport is already spent by the time
     * the table starts, exactly as on the optimizer. The floor is therefore the
     * decision, not the safety net, and fullscreen is the gesture that gives the
     * table the whole screen. Measured at 1280x720 in `grid.spec.ts`, which
     * asserts both this height and that no screen space is left unused below it.
     */
    <>
    <PerformanceSummary rows={model.matchedRows} performance={props.performance} view={view} onChange={update} currencyCode={props.currencyCode} profileId={props.profileId} />
    <TargetDrawerProvider profileId={props.profileId} window={props.period} currencyCode={props.currencyCode}><GridViewport
      fullscreen={fullscreen}
      onExitFullscreen={() => setFullscreen(false)}
      minHeight={GRID_MIN_HEIGHT}
    >
    <div
      data-testid="grid-data-ready"
      data-ready={viewReady ? 'true' : 'false'}
      aria-busy={!viewReady}
      style={{ display: 'flex', flex: '1 1 auto', flexDirection: 'column', gap: 0, minHeight: 0 }}
    >
      {saveError === null ? null : <p role="alert">{saveError}</p>}
      <div data-testid="grid-toolbar-readiness" aria-busy={!viewReady}>
        {viewReady ? (
          <PerformanceToolbar
            view={view}
            update={update}
            profileId={props.profileId}
            onRefreshTranslation={translation.refresh}
            asinScope={asinScope}
            onRemoveScope={() => { const url = new URL(window.location.href); url.searchParams.delete('asin'); window.history.replaceState(null, '', url); }}
            onTranslation={() => update({ translation: { language: view.translation?.language ?? 'en' } })}
            entity={props.entity}
            onEntityChange={(entity) => {
              const params = new URLSearchParams({
                profile: props.profileId,
                entity,
                from: props.period.start,
                to: props.period.end,
              });
              router.push(`/grid?${params.toString()}`);
            }}
            available={available}
            visible={visibleColumns.map((column) => column.id)}
            onVisibleChange={(columns) => update({ columns })}
            filter={view.filter}
            onFilterChange={(filter) => update({ filter })}
            groupBy={model.groupBy}
            onGroupByChange={(groupBy) => update({ groupBy, collapsedGroupIds: [] })}
            model={model}
            optionRows={scopedRows}
            onExport={handleExport}
            views={saved}
            onApplyView={(applied) => {
              const restored = withValidGrouping(applied, available);
              setView(restored);
              layoutWrites?.remember(restored);
            }}
            onSaveView={handleSaveView}
            onSaveColumnPreset={async (name, layout) => {
              if (!store) throw new Error('Saved views unavailable');
              const existing = saved.find((item) => item.name === name);
              await store.save({ ...view, ...layout, id: existing?.id ?? newViewId(), name });
              setSaved(await store.list(props.entity));
            }}
            onRemoveView={handleRemoveView}
            density={density}
            onDensityChange={(next) => update({ density: next })}
            fullscreen={fullscreen}
            onFullscreenChange={setFullscreen}
          />
        ) : (
          <p role="status" data-testid="grid-layout-restoring" className="wa-hint">
            Restoring your saved grid layout…
          </p>
        )}
      </div>


      {!viewReady || filterError === null ? null : (
        <p role="alert" style={filterErrorStyle}>
          Filter not applied — {filterError}. Every row is shown until the filter is fixed or
          removed.
        </p>
      )}

      <div data-testid="grid-worktable" style={{ display: 'flex', flex: '1 1 auto', flexDirection: 'column', minHeight: 0 }}>
      {viewReady ? (
        <DataGrid
          presentation="performance"
          style={{ marginInline: 24, border: 0, borderRadius: 0 }}
          model={model}
          renderCell={{ ...renderCells, selection: (row) => <SelectRowCheckbox row={row} identity={identityColumn} checked={selectedRowSet.has(row.id)} onToggle={() => setSelectedRowIds((ids) => ids.includes(row.id) ? ids.filter((id) => id !== row.id) : [...ids, row.id])} /> }}
          renderHeader={{ selection: () => <SelectAllMatched rowIds={matchedRowIds} selected={selectedRowSet} onChange={setSelectedRowIds} />, signals: () => <DataGrid.cells.SignalsLegend /> }}
          collapsedGroupIds={view.collapsedGroupIds ?? []}
          onCollapsedGroupIdsChange={(collapsedGroupIds) => update({ collapsedGroupIds })}
          columns={[{ id: 'selection', header: 'Select', kind: 'control', cell: 'selection', scale: 'text', align: 'left', width: 28, minWidth: 28, pinned: true }, ...visibleColumns]}
          currencyCode={props.currencyCode}
          sort={view.sort}
          onSortChange={(sort: SortRule[]) => update({ sort })}
          onWidthChange={(columnId, width) => update({ widths: { ...view.widths, [columnId]: width } })}
          onPinChange={(columnId, pinned) =>
            update({
              pinned: pinned
                ? [...view.pinned, columnId]
                : view.pinned.filter((id) => id !== columnId),
            })
          }
          onReorder={handleReorder}
          density={density}
          rowHeight={density === 'compact' ? 32 : 42}
          selectedRowIds={selectedRowIds}
          onSelectionChange={setSelectedRowIds}
          {...(props.entity === 'targets'
            ? {
                onRowClick: (row: GridRow) => {
                  const targetId = row.dimensions['target_id'];
                  if (targetId !== null && targetId !== undefined) router.push(rowHref(row));
                },
              }
            : {})}
        />
      ) : null}

      {view.columns.includes('translation') ? <p style={{ fontSize: 11, paddingInline: 24 }}>Use the original wording when editing a target. Translation helps you read it.</p> : null}
      <p data-testid="grid-scroll-disclosure" style={{ fontSize: 11, margin: 0, padding: '5px 24px', color: tokens.color.textMuted }}>Scroll sideways to see every selected column. No columns are dropped. {viewReady ? <a data-testid="grid-start-experiment" href={experimentHref} style={{ marginLeft: 16 }}>Start experiment from this view</a> : null}</p>
    </div>
    </div>
    </GridViewport></TargetDrawerProvider>
    </>
  );
}

export function withValidGrouping(view: SavedView, available: readonly GridColumn[]): SavedView {
  const dimensions = new Set(
    available.filter((column) => column.kind === 'dimension').map((column) => column.id),
  );
  const requested = Array.isArray(view.groupBy)
    ? view.groupBy.filter((columnId): columnId is string => typeof columnId === 'string')
    : [];
  return {
    ...view,
    groupBy: [...new Set(requested)].filter((columnId) => dimensions.has(columnId)),
  };
}

/**
 * Hand the file to the browser.
 *
 * An object URL rather than a data URI: a 50k-row export is comfortably past
 * the length a data URI survives in several browsers, and silently truncating
 * an export is the worst possible failure for a file somebody is about to
 * reconcile against Amazon.
 */
const filterErrorStyle = {
  background: tokens.color.badSoft,
  border: `1px solid ${tokens.color.badBorder}`,
  borderRadius: tokens.radius.md,
  color: tokens.color.bad,
  fontSize: tokens.font.size.sm,
  margin: 0,
  padding: `${tokens.space(2)} ${tokens.space(3)}`,
};

const loadPanelStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: tokens.space(2),
  padding: tokens.space(4),
};

function downloadCsv(csv: string, filename: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
