'use client';

/**
 * The review workspace: filter, inspect, decide, export.
 *
 * The queue is the Data Grid (`@wizard-ads/ui`), not a stack of bespoke
 * `<table>`s: one continuous scroller over every loaded proposal, click-to-sort
 * on every data column, shift-click to add a key, and a group bar that takes a
 * dragged header and nests a second level.
 *
 * It opens ungrouped, and that is a decision rather than an omission. Grouping
 * in this grid *replaces* source rows with their aggregates (`aggregate.ts`),
 * which is right for a metric grid and wrong as a default for a decision queue:
 * an operator cannot tick a checkbox on a summary. The lane the old lane
 * sections carried survives as the `Queue` column, and the rows arrive in the
 * order `groupByDecision` has always produced — needs review, then ready to
 * export, then completed, by reason inside each. Dropping `Queue` on the group
 * bar rebuilds those lanes as a treegrid whenever the operator wants the
 * counts instead of the rows.
 *
 * The two trust-building interactions from the recon (`tools/recon/04-optimizer.md`)
 * are unchanged:
 *
 * - **Bulk action over a filtered set.** Narrow by reason, status, strategy or
 *   text; the decision buttons then act on exactly what is on screen. "The
 *   single most valuable interaction in the product."
 * - **The three-act approval gesture for anything that leaves the tool.**
 *   Choose rows, tick a separate "Yes, export changes" box, then press
 *   Export. Three distinct acts, one of which is affirming intent.
 *
 * And the one place we deliberately differ: the incumbent's optimizer can run
 * unattended on a schedule. Ours is preview-first by design — nothing leaves
 * this screen without a human, a note, and a confirmation.
 *
 * ## A decision no longer throws the screen away
 *
 * Every decision used to end in `window.location.reload()`, which discarded the
 * filter the operator had just built, the selection they were working through,
 * the evidence they had open and their place in the queue — and wiped the
 * result message before it could be read. A decision now applies an optimistic
 * status locally and calls `router.refresh()`; React re-renders in place, the
 * server's own statuses arrive a moment later, and an effect drops each
 * optimistic entry as the server confirms it. The result is rendered inline.
 *
 * ## Loaded rows are not the run
 *
 * `listRecommendations` caps this page at `RECOMMENDATION_QUEUE_LOAD_CAP` rows
 * and returns no completeness metadata, so every count on the filter and
 * selection controls says *loaded rows* and a truncation notice appears when
 * the run holds more than arrived. The run's own per-status counts are a
 * database aggregate over the whole run, which is why the export control — and
 * only the export control, because an export with no selection is executed
 * server-side over every accepted proposal — may speak for the run.
 */
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  DEFAULT_DENSITY,
  DENSITY_LABELS,
  DataGrid,
  GRID_DENSITIES,
  GridViewport,
  GroupBar,
  buildGridModel,
  rowHeightFor,
} from '@wizard-ads/ui';
import type { GridColumn, GridDensity, GridRow, SortRule } from '@wizard-ads/ui';
import type { ProposalView } from '../../src/recommendations/view';
import { groupByDecision, groupByReason } from '../../src/recommendations/view';
import { can } from '../../src/auth/roles';
import type { OrgRole } from '../../src/auth/roles';

export interface ReviewWorkspaceProps {
  proposals: readonly ProposalView[];
  runId: string;
  profileId: string;
  client: string;
  /** The profile's currency. The grid needs one; no column here is money. */
  currencyCode: string;
  /** Live per-status counts for the whole run, straight from the database. */
  counts: Record<string, number>;
  role: string;
  hasStrategySnapshot: boolean;
  runGroupName?: string | null;
  /**
   * Test seam. The virtualizer measures a real element and jsdom has none, so
   * a unit test hands it one box. Production measures the viewport.
   */
  initialGridRect?: { width: number; height: number };
}

const STATUSES = ['proposed', 'accepted', 'dismissed', 'exported', 'applied', 'superseded'];
const LEVERS = ['bid-down', 'push', 'waste-cut', 'budget', 'placement', 'negative', 'pause', 'other'];

const SELECT_COLUMN_ID = 'select';
const EVIDENCE_COLUMN_ID = 'evidence';

interface Filters {
  reason: string;
  status: string;
  objective: string;
  text: string;
}

type ReviewPanel = 'dismiss' | 'export' | null;
type Decision = 'accepted' | 'dismissed' | 'proposed';

/**
 * A status this client wrote before the server answered, tagged with the
 * refresh generation it was written against so it can be retired on time
 * rather than on agreement.
 */
interface OptimisticStatus {
  readonly status: string;
  readonly writtenAt: number;
}

const EMPTY_FILTERS: Filters = { reason: '', status: '', objective: '', text: '' };

function matches(proposal: ProposalView, filters: Filters): boolean {
  if (filters.reason && proposal.reason !== filters.reason) return false;
  if (filters.status && proposal.status !== filters.status) return false;
  if (filters.objective && proposal.strategy.objective !== filters.objective) return false;
  if (filters.text) {
    const needle = filters.text.toLowerCase();
    const haystack = `${proposal.entityLabel} ${proposal.scope} ${proposal.entityId}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

function percent(value: number | null): string {
  if (value === null) return '—';
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`;
}

const dimension = (
  id: string,
  header: string,
  options: Partial<GridColumn> = {},
): GridColumn => ({
  id,
  header,
  kind: 'dimension',
  scale: 'text',
  align: 'left',
  width: 160,
  ...options,
});

/**
 * The queue's columns.
 *
 * Two are `control`: the selection checkbox and the evidence toggle. They hold
 * a gesture, not a value, so they carry no ordering — the header offers no
 * `aria-sort` and a click on it does nothing (`packages/ui/src/columns.ts`).
 *
 * `queue` is the decision lane, resolved by `groupByDecision` rather than
 * restated here, and it is the column the old lane sections became. `delta` is
 * the only numeric column; `current_value` and `proposed_value` stay the exact strings
 * the view model produced, because the field behind them changes from row to
 * row (a bid, a budget, a placement modifier) and there is no single scale that
 * would be true for all of them.
 */
export function reviewQueueColumns(): GridColumn[] {
  return [
    {
      id: SELECT_COLUMN_ID,
      header: 'Select',
      kind: 'control',
      scale: 'text',
      align: 'left',
      width: 44,
      pinned: true,
    },
    dimension('entity', 'Entity', { width: 260, pinned: true }),
    dimension('queue', 'Queue', { width: 150, filterKind: 'categorical' }),
    dimension('reason', 'Reason', { width: 180, filterKind: 'categorical' }),
    dimension('objective', 'Objective', { width: 170, filterKind: 'categorical' }),
    dimension('scope', 'Scope', { width: 240 }),
    dimension('field', 'Field', { width: 100, filterKind: 'categorical' }),
    dimension('current_value', 'Current', { align: 'right', width: 104 }),
    dimension('proposed_value', 'Proposed', { align: 'right', width: 104 }),
    dimension('delta', 'Δ', {
      scale: 'percent',
      align: 'right',
      width: 88,
      description: 'Signed relative change from the current value to the proposed one.',
    }),
    dimension('status', 'Status', { width: 120, filterKind: 'categorical' }),
    {
      id: EVIDENCE_COLUMN_ID,
      header: 'Evidence',
      kind: 'control',
      scale: 'text',
      align: 'left',
      width: 150,
    },
  ];
}

/**
 * One proposal as a grid row.
 *
 * The base sums are zero and stay unrendered: a proposal is a decision about an
 * entity, not a measurement of one, and this grid shows no metric column. They
 * exist because `GridRow` carries them for every consumer; the evidence panel
 * is where a proposal's own numbers live.
 */
export function toReviewGridRows(
  proposals: readonly ProposalView[],
  queueLabels: ReadonlyMap<string, string>,
  currencyCode: string,
): GridRow[] {
  return proposals.map((proposal) => ({
    id: proposal.id,
    dimensions: {
      entity: proposal.entityLabel,
      queue: queueLabels.get(proposal.id) ?? null,
      reason: proposal.reasonLabel,
      objective: proposal.strategyLabel,
      scope: proposal.scope,
      field: proposal.field,
      current_value: proposal.currentValue,
      proposed_value: proposal.proposedValue,
      delta: proposal.delta,
      status: proposal.status,
    },
    totals: { impressions: 0, clicks: 0, spend: 0, sales: 0, orders: 0, units: 0 },
    comparison: null,
    currencyCode,
  }));
}

/** The `refused` array the decide route returns, read defensively. */
function readRefused(value: unknown): { id: string; status: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const id = record['id'];
    const status = record['status'];
    return typeof id === 'string' && typeof status === 'string' ? [{ id, status }] : [];
  });
}

export function ReviewWorkspace(props: ReviewWorkspaceProps): ReactNode {
  const router = useRouter();
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [activePanel, setActivePanel] = useState<ReviewPanel>(null);
  const [dismissalNote, setDismissalNote] = useState('');
  const [exportNote, setExportNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [optGroup, setOptGroup] = useState(
    () => props.runGroupName ?? props.proposals.find((proposal) => proposal.strategy.optGroup !== null)?.strategy.optGroup ?? 'ungrouped',
  );
  const [lever, setLever] = useState('bid-down');
  const [busy, setBusy] = useState(false);
  const [decisionMessage, setDecisionMessage] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortRule[]>([]);
  const [groupBy, setGroupBy] = useState<readonly string[]>([]);
  const [density, setDensity] = useState<GridDensity>(DEFAULT_DENSITY);
  const [fullscreen, setFullscreen] = useState(false);
  /** id → the status this client wrote, until a refresh has answered for it. */
  const [optimistic, setOptimistic] = useState<ReadonlyMap<string, OptimisticStatus>>(new Map());
  /**
   * How many server payloads have arrived since this component mounted, and
   * which payload each optimistic write was made against. A write is retired
   * once a payload landed after it, whatever that payload says.
   */
  const refreshes = useRef(0);
  const dismissalNoteRef = useRef<HTMLTextAreaElement>(null);
  const exportNoteRef = useRef<HTMLTextAreaElement>(null);
  const dismissButtonRef = useRef<HTMLButtonElement>(null);
  const exportButtonRef = useRef<HTMLButtonElement>(null);

  const serverStatus = useMemo(
    () => new Map(props.proposals.map((proposal) => [proposal.id, proposal.status] as const)),
    [props.proposals],
  );

  /**
   * Reconcile on time, not on agreement.
   *
   * An optimistic status is a claim made while the server had not answered
   * yet. It survives until a payload rendered *after* the write arrives, and
   * then it goes — whether or not the server says what this client expected.
   * Retiring only on agreement pins any disagreement forever: a proposal a
   * concurrent run superseded, or a row the route silently refused, would
   * contradict the database, and the shifted run counts with it, until the
   * page was reloaded. The server is authoritative once it has answered; the
   * optimistic value only covers the gap before it does.
   */
  const lastServer = useRef(serverStatus);
  useEffect(() => {
    if (lastServer.current !== serverStatus) {
      lastServer.current = serverStatus;
      refreshes.current += 1;
    }
    const landed = refreshes.current;
    setOptimistic((current) => {
      if (current.size === 0) return current;
      const next = new Map(
        [...current].filter(
          ([id, entry]) => entry.writtenAt >= landed && serverStatus.get(id) !== entry.status,
        ),
      );
      return next.size === current.size ? current : next;
    });
  }, [serverStatus]);

  const proposals = useMemo(
    () =>
      props.proposals.map((proposal) => {
        const pending = optimistic.get(proposal.id)?.status;
        return pending === undefined || pending === proposal.status
          ? proposal
          : { ...proposal, status: pending };
      }),
    [optimistic, props.proposals],
  );

  /**
   * The run's counts, moved by whatever this client has decided and the server
   * has not yet reported. The total is conserved: a decision moves a proposal
   * between statuses, it never creates or destroys one.
   */
  const counts = useMemo(() => {
    const next: Record<string, number> = { ...props.counts };
    for (const proposal of props.proposals) {
      const pending = optimistic.get(proposal.id)?.status;
      if (pending === undefined || pending === proposal.status) continue;
      next[proposal.status] = Math.max(0, (next[proposal.status] ?? 0) - 1);
      next[pending] = (next[pending] ?? 0) + 1;
    }
    return next;
  }, [optimistic, props.counts, props.proposals]);

  const runTotal = useMemo(
    () => Object.values(props.counts).reduce((sum, value) => sum + value, 0),
    [props.counts],
  );
  const loaded = props.proposals.length;
  const truncated = loaded < runTotal;

  const visible = useMemo(
    () => proposals.filter((proposal) => matches(proposal, filters)),
    [proposals, filters],
  );

  /**
   * Decision lane per proposal, and the queue order: lane, then reason, then
   * the order the run produced. `groupByDecision` is the authority for both, so
   * this component never restates which status belongs in which lane.
   */
  const lanes = useMemo(() => groupByDecision(visible), [visible]);
  const queueLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const lane of lanes) {
      for (const proposal of lane.proposals) labels.set(proposal.id, lane.label);
    }
    return labels;
  }, [lanes]);
  const orderedVisible = useMemo(
    () => lanes.flatMap((lane) => lane.reasons.flatMap((group) => group.proposals)),
    [lanes],
  );

  const objectives = useMemo(
    () => [...new Set(props.proposals.map((proposal) => proposal.strategy.objective))].sort(),
    [props.proposals],
  );
  const strategyGroups = useMemo(
    () => [
      ...new Set(
        props.proposals.flatMap((proposal) =>
          proposal.strategy.optGroup === null ? [] : [proposal.strategy.optGroup],
        ),
      ),
    ].sort(),
    [props.proposals],
  );

  const selectedIds = useMemo(
    () => visible.filter((proposal) => selected.has(proposal.id)).map((proposal) => proposal.id),
    [visible, selected],
  );
  const canExport = can(props.role as OrgRole, 'exportBatches');
  const acceptedSelected = useMemo(
    () => visible.filter((proposal) => selected.has(proposal.id) && proposal.status === 'accepted').length,
    [visible, selected],
  );
  const exportCount = selectedIds.length > 0 ? acceptedSelected : (counts['accepted'] ?? 0);

  const columns = useMemo(() => reviewQueueColumns(), []);
  const dimensions = useMemo(
    () => columns.filter((column) => column.kind === 'dimension'),
    [columns],
  );
  const byId = useMemo(
    () => new Map(proposals.map((proposal) => [proposal.id, proposal] as const)),
    [proposals],
  );
  const gridRows = useMemo(
    () => toReviewGridRows(orderedVisible, queueLabels, props.currencyCode),
    [orderedVisible, props.currencyCode, queueLabels],
  );
  const model = useMemo(() => buildGridModel(gridRows, { sort, groupBy }), [gridRows, groupBy, sort]);
  // Grouping folds the proposals into summaries, so the per-row gestures have
  // nothing to act on; say so rather than leaving an operator hunting for the
  // checkboxes they just lost.
  const grouped = model.grouped;
  const selectedRowIds = useMemo(() => [...selected], [selected]);
  const allVisibleSelected =
    visible.length > 0 && visible.every((proposal) => selected.has(proposal.id));
  const someVisibleSelected = visible.some((proposal) => selected.has(proposal.id));
  const openEvidence = useMemo(
    () => orderedVisible.filter((proposal) => expanded.has(proposal.id)),
    [expanded, orderedVisible],
  );

  useEffect(() => {
    if (activePanel === 'dismiss') dismissalNoteRef.current?.focus();
    if (activePanel === 'export') exportNoteRef.current?.focus();
  }, [activePanel]);

  const toggle = useCallback((id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleEvidence = useCallback((id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /**
   * Add every filtered loaded row to the selection without disturbing rows the
   * current filter hides. Narrowing a filter must never silently drop what an
   * operator already chose; `Clear selection` is the control that does that.
   */
  const selectAllVisible = useCallback(() => {
    setSelected((current) => {
      const next = new Set(current);
      for (const proposal of visible) next.add(proposal.id);
      return next;
    });
  }, [visible]);

  const toggleAllVisible = useCallback(() => {
    setSelected((current) => {
      const next = new Set(current);
      if (visible.every((proposal) => next.has(proposal.id))) {
        for (const proposal of visible) next.delete(proposal.id);
      } else {
        for (const proposal of visible) next.add(proposal.id);
      }
      return next;
    });
  }, [visible]);

  const clearSelection = useCallback(() => {
    setSelected(new Set());
    setActivePanel(null);
    setConfirmed(false);
  }, []);

  /** The grid's own selection keys (Space toggles, Escape clears) land here. */
  const applyGridSelection = useCallback((rowIds: readonly string[]) => {
    setSelected(new Set(rowIds));
  }, []);

  const closePanel = useCallback((panel: Exclude<ReviewPanel, null>) => {
    if (panel === 'dismiss') dismissButtonRef.current?.focus();
    else exportButtonRef.current?.focus();
    setActivePanel(null);
  }, []);

  const post = useCallback(async (url: string, body: unknown): Promise<Record<string, unknown>> => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = (await response.json()) as Record<string, unknown>;
    if (!response.ok) throw new Error(String(payload['error'] ?? response.statusText));
    return payload;
  }, []);

  const decide = useCallback(
    async (decision: Decision, decisionNote = '') => {
      setError(null);
      setDecisionMessage(null);
      if (selectedIds.length === 0) {
        setError('Select at least one proposal first.');
        return;
      }
      if (decision === 'dismissed' && decisionNote.trim().length === 0) {
        setError('A dismissal needs a note: record why this proposal is not being taken.');
        return;
      }
      setBusy(true);
      const offered = selectedIds;
      try {
        const result = await post('/api/recommendations/decide', {
          ids: offered,
          decision,
          note: decisionNote,
        });
        // The route reports what it refused and what those rows really are, so
        // the optimistic state can be exactly right rather than hopeful.
        const refused = readRefused(result['refused']);
        const refusedIds = new Set(refused.map((entry) => entry.id));
        const writtenAt = refreshes.current;
        setOptimistic((current) => {
          const next = new Map(current);
          for (const id of offered) {
            if (!refusedIds.has(id)) next.set(id, { status: decision, writtenAt });
          }
          for (const entry of refused) next.set(entry.id, { status: entry.status, writtenAt });
          return next;
        });
        setDecisionMessage(
          `${String(result['updated'])} of ${String(result['offered'])} proposals moved to ${decision}.`
            + (refused.length === 0
              ? ''
              : ` ${refused.length} refused: a proposal that has already been exported or applied cannot be decided again.`),
        );
        if (decision === 'dismissed') {
          setDismissalNote('');
          closePanel('dismiss');
        }
        // In place, not a reload: the filter, the selection, the open evidence
        // and the scroll position are the operator's working state.
        router.refresh();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Decision failed');
      } finally {
        setBusy(false);
      }
    },
    [closePanel, post, router, selectedIds],
  );

  const openDismissal = useCallback(() => {
    setError(null);
    setDecisionMessage(null);
    setMessage(null);
    if (selectedIds.length === 0) {
      setError('Select at least one proposal first.');
      return;
    }
    setActivePanel('dismiss');
    setConfirmed(false);
  }, [selectedIds.length]);

  const openExport = useCallback(() => {
    setError(null);
    setMessage(null);
    if (exportCount === 0) {
      setError('Select accepted proposals, or clear the selection to export every accepted proposal.');
      return;
    }
    setActivePanel('export');
    setConfirmed(false);
  }, [exportCount]);

  const exportBatch = useCallback(async () => {
    setError(null);
    setMessage(null);
    if (!confirmed) {
      setError('Tick "Yes, export changes" before exporting.');
      return;
    }
    if (exportNote.trim().length === 0) {
      setError('An export needs a note: it is the note the staged apply carries.');
      return;
    }
    setBusy(true);
    try {
      const result = await post('/api/recommendations/export', {
        runId: props.runId,
        profileId: props.profileId,
        client: props.client,
        optGroup,
        lever,
        note: exportNote,
        ids: selectedIds.length > 0 ? selectedIds : null,
      });
      const downloads = result['downloads'] as Record<string, string>;
      setMessage(
        `Exported ${String(result['exported'])} of ${String(result['accepted'])} accepted proposals as ${String(result['tag'])}. ` +
          `Download: rows ${downloads['rows']} · caps ${downloads['caps']} · workbook ${downloads['workbook']}`,
      );
      setConfirmed(false);
      // The export moved statuses server-side; ask for them rather than
      // leaving the queue showing the world before the batch.
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Export failed');
    } finally {
      setBusy(false);
    }
  }, [confirmed, exportNote, lever, optGroup, post, props.client, props.profileId, props.runId, router, selectedIds]);

  const renderHeader = useMemo(
    () => ({
      [SELECT_COLUMN_ID]: () => (
        <input
          aria-label={`${allVisibleSelected ? 'Deselect' : 'Select'} all ${visible.length.toLocaleString('en-US')} filtered loaded rows`}
          checked={allVisibleSelected}
          className="wa-checkbox"
          data-testid="review-select-filtered"
          disabled={busy || visible.length === 0}
          onChange={toggleAllVisible}
          onClick={(event) => event.stopPropagation()}
          ref={(element) => {
            if (element !== null) element.indeterminate = !allVisibleSelected && someVisibleSelected;
          }}
          type="checkbox"
        />
      ),
    }),
    [allVisibleSelected, busy, someVisibleSelected, toggleAllVisible, visible.length],
  );

  const renderCell = useMemo(
    () => ({
      [SELECT_COLUMN_ID]: (row: GridRow) => {
        const proposal = byId.get(row.id);
        if (proposal === undefined) return null;
        return (
          <input
            aria-label={`Select ${proposal.entityLabel}`}
            checked={selected.has(proposal.id)}
            className="wa-checkbox"
            onChange={() => toggle(proposal.id)}
            onClick={(event) => event.stopPropagation()}
            type="checkbox"
          />
        );
      },
      entity: (row: GridRow) => {
        const proposal = byId.get(row.id);
        if (proposal === undefined) return null;
        return (
          <span data-testid={`proposal-${proposal.id}`} data-status={proposal.status} style={ellipsis}>
            {proposal.entityLabel}
          </span>
        );
      },
      objective: (row: GridRow) => {
        const proposal = byId.get(row.id);
        if (proposal === undefined) return null;
        return (
          <span data-testid={`objective-${proposal.id}`} style={ellipsis}>
            {proposal.strategyLabel}
          </span>
        );
      },
      delta: (row: GridRow) => {
        const proposal = byId.get(row.id);
        if (proposal === undefined) return null;
        return <>{percent(proposal.delta)}</>;
      },
      [EVIDENCE_COLUMN_ID]: (row: GridRow) => {
        const proposal = byId.get(row.id);
        if (proposal === undefined) return null;
        const open = expanded.has(proposal.id);
        return (
          <button
            aria-expanded={open}
            aria-label={`${open ? 'Hide' : 'Show'} evidence for ${proposal.entityLabel}`}
            className="wa-btn wa-btn--ghost wa-btn--sm"
            data-testid={`evidence-toggle-${proposal.id}`}
            onClick={(event) => {
              event.stopPropagation();
              toggleEvidence(proposal.id);
            }}
            type="button"
          >
            {open ? 'Hide evidence' : 'Show evidence'}
          </button>
        );
      },
    }),
    [byId, expanded, selected, toggle, toggleEvidence],
  );

  const onRowClick = useCallback(
    (row: GridRow) => {
      if (byId.has(row.id)) toggleEvidence(row.id);
    },
    [byId, toggleEvidence],
  );

  return (
    <section className="wa-review" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <div className="wa-review__summary" data-testid="run-counts">
        <div className="wa-review__stat wa-review__stat--attention">
          <span className="wa-label">Needs review</span>
          <strong>{counts['proposed'] ?? 0}</strong>
          {' '}
          <span>new proposals</span>
        </div>
        <div className="wa-review__stat">
          <span className="wa-label">Ready to export</span>
          <strong>{counts['accepted'] ?? 0}</strong>
          {' '}
          <span>accepted proposals</span>
        </div>
        <div className="wa-review__stat">
          <span className="wa-label">Completed</span>
          <strong>
            {(counts['dismissed'] ?? 0) +
              (counts['exported'] ?? 0) +
              (counts['applied'] ?? 0) +
              (counts['superseded'] ?? 0)}
          </strong>
          <span data-testid="exported-count">
            {counts['exported'] ?? 0} exported · {counts['dismissed'] ?? 0} dismissed
          </span>
        </div>
      </div>

      {props.hasStrategySnapshot ? null : (
        <p style={warning} role="status">
          This run stored no strategy snapshot, so every proposal shows as unassigned. The objective
          column is honest about that rather than guessing one.
        </p>
      )}

      {truncated ? (
        <p style={warning} role="status" data-testid="queue-truncated">
          This queue loaded {loaded.toLocaleString('en-US')} of the{' '}
          {runTotal.toLocaleString('en-US')} proposals in this run. Filtering, sorting, grouping and
          selection act on the loaded rows only. An export with no selection is executed on the
          server over every accepted proposal in the run, so it is the one count here that speaks
          for more than what loaded.
        </p>
      ) : null}

      <div
        className="wa-review__filterbar"
        role="search"
        aria-label="Filter recommendations"
        data-testid="review-filters"
      >
        <div className="wa-review__filter-heading">
          <strong>Recommendation queue</strong>
          <span data-testid="queue-count">
            {visible.length} of {loaded} loaded rows shown
          </span>
        </div>
        <label className="wa-review__filter">
          <span>Reason</span>
          <select
            className="wa-select wa-select--sm"
            value={filters.reason}
            onChange={(event) => setFilters({ ...filters, reason: event.target.value })}
          >
            <option value="">All</option>
            {groupByReason(props.proposals).map((group) => (
              <option key={group.reason} value={group.reason}>
                {group.label}
              </option>
            ))}
          </select>
        </label>
        <label className="wa-review__filter">
          <span>Status</span>
          <select
            className="wa-select wa-select--sm"
            value={filters.status}
            onChange={(event) => setFilters({ ...filters, status: event.target.value })}
          >
            <option value="">All</option>
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </label>
        <label className="wa-review__filter">
          <span>Objective</span>
          <select
            className="wa-select wa-select--sm"
            value={filters.objective}
            onChange={(event) => setFilters({ ...filters, objective: event.target.value })}
          >
            <option value="">All</option>
            {objectives.map((objective) => (
              <option key={objective} value={objective}>
                {objective}
              </option>
            ))}
          </select>
        </label>
        <label className="wa-review__filter wa-review__filter--search">
          <span>Search</span>
          <input
            className="wa-input wa-input--sm"
            type="text"
            value={filters.text}
            onChange={(event) => setFilters({ ...filters, text: event.target.value })}
            placeholder="Campaign, target, or ID"
          />
        </label>
        <button className="wa-btn wa-btn--ghost wa-btn--sm" type="button" onClick={() => setFilters(EMPTY_FILTERS)}>
          Clear filters
        </button>
      </div>

      <div
        className="wa-review__actionbar"
        aria-label="Selection and decisions"
        data-testid="review-actionbar"
      >
        <div className="wa-review__selection">
          <span className="wa-review__selection-count" data-testid="selection-count" aria-live="polite">
            <strong>{selectedIds.length}</strong> of {visible.length} filtered loaded rows selected
            {selectedIds.length === 0 ? '' : ` · ${acceptedSelected} accepted`}
          </span>
          <button
            className="wa-btn wa-btn--sm"
            type="button"
            onClick={selectAllVisible}
            disabled={busy || visible.length === 0}
          >
            Select all {visible.length} filtered loaded rows
          </button>
          <button
            className="wa-btn wa-btn--ghost wa-btn--sm"
            type="button"
            onClick={clearSelection}
            disabled={busy || selected.size === 0}
          >
            Clear selection
          </button>
          <span style={muted}>Selections hidden by the current filters remain selected.</span>
        </div>
        <div className="wa-review__decisions">
          <button
            className="wa-btn wa-btn--primary wa-btn--sm"
            type="button"
            onClick={() => void decide('accepted')}
            disabled={busy || selectedIds.length === 0}
          >
            {selectedIds.length > 0 ? `Accept ${selectedIds.length} selected` : 'Accept selected'}
          </button>
          <button
            ref={dismissButtonRef}
            className="wa-btn wa-btn--sm"
            type="button"
            onClick={openDismissal}
            disabled={busy || selectedIds.length === 0}
            aria-expanded={activePanel === 'dismiss'}
            aria-controls="dismissal-controls"
          >
            {selectedIds.length > 0 ? `Dismiss ${selectedIds.length} selected` : 'Dismiss selected'}
          </button>
          <button
            className="wa-btn wa-btn--ghost wa-btn--sm"
            type="button"
            onClick={() => void decide('proposed')}
            disabled={busy || selectedIds.length === 0}
          >
            {selectedIds.length > 0 ? `Re-open ${selectedIds.length} selected` : 'Re-open selected'}
          </button>
          <span className="wa-review__action-divider" aria-hidden="true" />
          <button
            ref={exportButtonRef}
            className="wa-btn wa-btn--sm"
            type="button"
            onClick={openExport}
            disabled={busy || !canExport || exportCount === 0}
            aria-expanded={activePanel === 'export'}
            aria-controls="export-controls"
          >
            Prepare export · {exportCount}
          </button>
        </div>
      </div>

      {activePanel === 'dismiss' ? (
        <section
          className="wa-review__composer"
          id="dismissal-controls"
          aria-labelledby="dismissal-title"
          onKeyDown={(event) => {
            if (event.key === 'Escape') closePanel('dismiss');
          }}
        >
          <div className="wa-review__composer-copy">
            <h2 id="dismissal-title">
              Dismiss {selectedIds.length} selected proposal{selectedIds.length === 1 ? '' : 's'}
            </h2>
            <p>Record why these recommendations should not move forward.</p>
          </div>
          <label className="wa-review__composer-field">
            Dismissal note
            <textarea
              ref={dismissalNoteRef}
              className="wa-textarea"
              value={dismissalNote}
              onChange={(event) => setDismissalNote(event.target.value)}
              rows={2}
              aria-label="Dismissal note"
            />
          </label>
          <div className="wa-review__composer-actions">
            <button className="wa-btn wa-btn--ghost wa-btn--sm" type="button" onClick={() => closePanel('dismiss')}>
              Cancel
            </button>
            <button
              className="wa-btn wa-btn--primary wa-btn--sm"
              type="button"
              onClick={() => void decide('dismissed', dismissalNote)}
              disabled={busy || selectedIds.length === 0}
            >
              Confirm dismissal · {selectedIds.length}
            </button>
          </div>
        </section>
      ) : null}

      {activePanel === 'export' ? (
        <section
          className="wa-review__composer wa-review__composer--export"
          id="export-controls"
          aria-labelledby="export-title"
          onKeyDown={(event) => {
            if (event.key === 'Escape') closePanel('export');
          }}
        >
          <div className="wa-review__composer-copy">
            <h2 id="export-title">
              Review export · {exportCount} accepted change{exportCount === 1 ? '' : 's'}
            </h2>
            <p>
              {selectedIds.length > 0
                ? `${acceptedSelected} accepted proposal${acceptedSelected === 1 ? '' : 's'} among the selected loaded rows.`
                : `Every accepted proposal in this run (${exportCount}).`}
              {' '}
              Creates review files only. OpenSpell does not update Amazon.
            </p>
          </div>
          <div className="wa-review__export-fields">
            <label className="wa-review__composer-field">
              Strategy group for export
              <select
                className="wa-select wa-select--sm"
                value={optGroup}
                onChange={(event) => setOptGroup(event.target.value)}
              >
                <option value="ungrouped">Ungrouped</option>
                {strategyGroups.map((group) => (
                  <option key={group} value={group}>{group}</option>
                ))}
              </select>
              <span>Selects caps from this run’s snapshot; it is not a persisted campaign assignment.</span>
            </label>
            <label className="wa-review__composer-field">
              Lever
              <select
                className="wa-select wa-select--sm"
                value={lever}
                onChange={(event) => setLever(event.target.value)}
              >
                {LEVERS.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label className="wa-review__composer-field wa-review__composer-field--note">
              Export note
              <textarea
                ref={exportNoteRef}
                className="wa-textarea"
                value={exportNote}
                onChange={(event) => setExportNote(event.target.value)}
                rows={2}
                aria-label="Export note"
              />
            </label>
          </div>
          <div className="wa-review__composer-actions wa-review__composer-actions--confirm">
            <label className="wa-review__confirmation">
              <input
                className="wa-checkbox"
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              Yes, export changes
            </label>
            <button className="wa-btn wa-btn--ghost wa-btn--sm" type="button" onClick={() => closePanel('export')}>
              Cancel
            </button>
            <button
              className="wa-btn wa-btn--primary wa-btn--sm"
              type="button"
              onClick={() => void exportBatch()}
              disabled={busy || !canExport || exportCount === 0}
              data-testid="export-accepted"
            >
              Export {exportCount} accepted change{exportCount === 1 ? '' : 's'}
            </button>
          </div>
        </section>
      ) : null}

      {canExport ? null : (
        <p style={muted}>Role {props.role} may review recommendations but not export changes.</p>
      )}

      {error === null ? null : (
        <p role="alert" style={warning} data-testid="review-error">
          {error}
        </p>
      )}
      {decisionMessage === null ? null : (
        <p role="status" style={notice} data-testid="decision-result">
          {decisionMessage}
        </p>
      )}
      {message === null ? null : (
        <p role="status" style={notice} data-testid="export-result">
          {message}
        </p>
      )}

      <GridViewport
        fullscreen={fullscreen}
        onExitFullscreen={() => setFullscreen(false)}
        minHeight={420}
      >
        <div style={{ alignItems: 'center', display: 'flex', gap: '0.5rem' }}>
          <div style={{ flex: '1 1 auto', minWidth: 0 }}>
            <GroupBar dimensions={dimensions} groupBy={model.groupBy} onChange={setGroupBy} />
          </div>
          <select
            aria-label="Row density"
            className="wa-select wa-select--sm"
            onChange={(event) => setDensity(event.target.value as GridDensity)}
            style={{ flex: '0 0 auto', width: 'auto' }}
            value={density}
          >
            {GRID_DENSITIES.map((value) => (
              <option key={value} value={value}>{DENSITY_LABELS[value]}</option>
            ))}
          </select>
          <button
            aria-pressed={fullscreen}
            className="wa-btn wa-btn--ghost wa-btn--sm"
            onClick={() => setFullscreen((current) => !current)}
            style={{ flex: '0 0 auto', whiteSpace: 'nowrap' }}
            type="button"
          >
            {fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
          </button>
        </div>

        {grouped ? (
          <p style={muted} role="status" data-testid="queue-grouped-note">
            Grouped rows are summaries of the loaded proposals. Remove the grouping levels to see
            individual proposals, their checkboxes and their evidence again.
          </p>
        ) : null}

        {/*
          * The grid keeps a floor of its own. Both it and the evidence stack
          * are flex children of the viewport column, and a grid whose
          * `minHeight` is zero will shrink to nothing to make room for an open
          * panel — which is exactly what it did the first time this was wired.
          */}
        <div style={gridFill}>
          <DataGrid
            model={model}
            columns={columns}
            currencyCode={props.currencyCode}
            sort={sort}
            onSortChange={setSort}
            selectedRowIds={selectedRowIds}
            onSelectionChange={applyGridSelection}
            onRowClick={onRowClick}
            renderCell={renderCell}
            renderHeader={renderHeader}
            density={density}
            {...(props.initialGridRect === undefined ? {} : { initialRect: props.initialGridRect })}
            rowHeight={rowHeightFor(density)}
            emptyMessage="No proposal matches this filter."
            noDataMessage="This run proposed nothing."
          />
        </div>

        {openEvidence.length === 0 ? null : (
          <section
            aria-label="Evidence for the open proposals"
            data-testid="review-evidence"
            style={evidenceRegion}
          >
            {openEvidence.map((proposal) => (
              <EvidencePanel
                key={proposal.id}
                proposal={proposal}
                onClose={() => toggleEvidence(proposal.id)}
              />
            ))}
          </section>
        )}
      </GridViewport>
    </section>
  );
}

/**
 * The provenance panel: the differentiator the brief names. AdLabs publishes
 * the formula; we publish the numbers that went into this row.
 *
 * It lives under the grid rather than as an expanded row because the grid is
 * virtualised and uniform-height by design. Several can be open at once and
 * each survives a decision, which is the point: the evidence is what the
 * operator is deciding against.
 */
function EvidencePanel({
  proposal,
  onClose,
}: {
  proposal: ProposalView;
  onClose: () => void;
}): ReactNode {
  return (
    <div style={provenancePanel} data-testid={`provenance-${proposal.id}`}>
      <div style={{ alignItems: 'baseline', display: 'flex', gap: '0.75rem', justifyContent: 'space-between' }}>
        <p style={{ margin: '0 0 0.5rem' }}>
          <strong>{proposal.entityLabel}</strong> · {proposal.scope} · {proposal.field}{' '}
          {proposal.currentValue} → {proposal.proposedValue} ({percent(proposal.delta)})
        </p>
        <button
          className="wa-btn wa-btn--ghost wa-btn--sm"
          onClick={onClose}
          type="button"
          aria-label={`Hide evidence for ${proposal.entityLabel}`}
        >
          Hide
        </button>
      </div>
      <p style={{ margin: '0 0 0.5rem' }}>
        <strong>Change reason — {proposal.reasonLabel}:</strong> {proposal.changeReason}
      </p>
      <p style={{ margin: '0 0 0.5rem' }} data-testid={`limit-${proposal.id}`}>
        <strong>Limit reason:</strong>{' '}
        {proposal.limitReason ?? 'nothing bound this value: no ceiling applied and no cap clamped.'}
      </p>
      <p style={{ margin: '0 0 0.5rem' }} data-testid={`strategy-${proposal.id}`}>
        <strong>Strategy — {proposal.strategyLabel}:</strong> {proposal.strategy.explanation}
        {proposal.strategy.targetAcos === null
          ? ''
          : ` Target ACOS ${(proposal.strategy.targetAcos * 100).toFixed(0)}%.`}
      </p>
      <dl style={definitions}>
        {proposal.provenance.map((line) => (
          <div key={line.key} style={definitionRow} data-provenance={line.key}>
            <dt style={{ fontWeight: 600 }}>{line.label}</dt>
            <dd style={{ margin: 0 }}>
              {line.value} <span style={muted}>— {line.hint}</span>
            </dd>
          </div>
        ))}
      </dl>
      {proposal.decisionNote === null ? null : (
        <p style={{ margin: '0.5rem 0 0' }}>
          <strong>Decision note:</strong> {proposal.decisionNote}
        </p>
      )}
      {proposal.exportBatchTag === null ? null : (
        <p style={{ margin: '0.5rem 0 0' }}>
          <strong>Exported in batch:</strong> {proposal.exportBatchTag}
        </p>
      )}
      {proposal.exportable ? null : (
        <p style={{ margin: '0.5rem 0 0' }}>
          This proposal creates an entity rather than changing one, so it ships as a create
          row in the workbook and is absent from the rows JSON.
        </p>
      )}
    </div>
  );
}

const muted: CSSProperties = { color: 'var(--wa-text-muted)', fontSize: '0.8125rem' };
const ellipsis: CSSProperties = {
  display: 'block',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
const gridFill: CSSProperties = {
  display: 'flex',
  flex: '1 1 auto',
  flexDirection: 'column',
  minHeight: 200,
};
/**
 * At most two fifths of the viewport column, and never at the grid's expense:
 * `minHeight: 0` is what lets it scroll internally instead of pushing the grid
 * out of the screen it shares.
 */
const evidenceRegion: CSSProperties = {
  display: 'flex',
  flex: '0 1 auto',
  flexDirection: 'column',
  gap: '0.5rem',
  maxHeight: '40%',
  minHeight: 0,
  overflowY: 'auto',
};
const provenancePanel: CSSProperties = {
  background: 'var(--wa-surface-2)',
  borderRadius: '0.375rem',
  overflowWrap: 'anywhere',
  padding: '0.75rem',
};
const definitions: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '0.25rem', margin: 0 };
const definitionRow: CSSProperties = {
  alignItems: 'baseline',
  display: 'grid',
  gap: '0.25rem 0.75rem',
  gridTemplateColumns: 'minmax(9rem, 13rem) minmax(0, 1fr)',
  overflowWrap: 'anywhere',
};
const warning: CSSProperties = {
  background: 'var(--wa-bad-bg)',
  border: '1px solid var(--wa-bad-border)',
  borderRadius: '0.375rem',
  color: 'var(--wa-bad-text)',
  margin: 0,
  padding: '0.5rem 0.75rem',
};
const notice: CSSProperties = {
  background: 'var(--wa-good-bg)',
  border: '1px solid var(--wa-good-border)',
  borderRadius: '0.375rem',
  color: 'var(--wa-good-text)',
  margin: 0,
  padding: '0.5rem 0.75rem',
};
