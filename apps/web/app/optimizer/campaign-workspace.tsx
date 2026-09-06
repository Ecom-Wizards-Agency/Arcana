'use client';

/**
 * The Campaign Optimizer workspace.
 *
 * The campaign table is the Data Grid (`@wizard-ads/ui`), not a bespoke
 * `<table>`: continuous scrolling over the whole campaign set the loader
 * returns, click-to-sort on every data column, shift-click to add a key, and a
 * group bar that takes a dragged header and nests a second level with ratios
 * recomputed from summed bases. There is no page slice; the recon
 * (`https://github.com/Ecom-Wizards-Agency/openspell/blob/1ca9bd7c253e2a3f6b8c8b5848ee7bfad695781f/tools/recon/02-data-grid.md` §6) is explicit that paginating a QA surface makes the
 * workflow it exists for impossible, and 25 rows at a time is what the operator
 * named first when comparing this page against AdLabs.
 *
 * Everything WP-195 built about *scope* is unchanged and is the reason the
 * selection lives here rather than in the grid: `selectedCampaignIds` is the
 * whole transient set, filters narrow what is on screen without touching it,
 * the header checkbox owns the complete filtered eligible population rather
 * than what happens to be rendered, and the preview scope stays an explicit
 * choice between all eligible campaigns and the selected ones. The grid paints
 * that selection and asks to change it; it never owns it.
 *
 * Absent is not zero, as in the table this replaced: a campaign Amazon reported
 * no row for in this period shows `—` for spend, sales, ACOS, orders and the
 * spend change, and carries a "No activity in this period" note under its name
 * alongside any reason it cannot be previewed. The two notes are independent
 * facts and a campaign is often both.
 */
import { useRouter } from 'next/navigation';
import type { OneTimeRpcConfiguration } from '@wizard-ads/shared';
import { OneTimeSettingsDialog } from './one-time-settings-dialog';
import { oneTimePreviewUnavailableMessage } from '../../src/optimizer/preview-availability';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  DEFAULT_DENSITY,
  DENSITY_LABELS,
  DataGrid,
  EMPTY_CELL,
  GRID_DENSITIES,
  GroupBar,
  GridViewport,
  allMetricColumns,
  buildGridModel,
  rowHeightFor,
} from '@wizard-ads/ui';
import type { GridColumn, GridDensity, GridRow, SortRule } from '@wizard-ads/ui';
import type {
  OptimizerCampaignRow,
  OptimizerPreviewAccepted,
  OptimizerPreviewBatchStatus,
} from '../../src/optimizer/campaigns';
import {
  filterOptimizerCampaignRows,
  optimizerPreviewError,
  parseOptimizerPreviewAccepted,
  parseOptimizerPreviewStatus,
} from '../../src/optimizer/campaigns';
import {
  OPTIMIZER_PREVIEW_BODY_MAX_BYTES,
  OPTIMIZER_PREVIEW_CAMPAIGN_MAX,
} from '../../src/optimizer/preview-http';

const POLL_DELAYS_MS = [1_000, 2_000, 5_000] as const;
const POLL_DEADLINE_MS = 10 * 60 * 1_000;

const SELECT_COLUMN_ID = 'select';
const RECOMMENDATION_COLUMN_ID = 'recommendation';
const DEFAULT_SORT: readonly SortRule[] = [{ columnId: 'spend', direction: 'desc' }];

type ScopeMode = 'all' | 'selected';

interface UncertainPreviewRequest {
  clientRequestId: string;
  scopeKey: string;
}

class UncertainPreviewResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UncertainPreviewResponseError';
  }
}

class PermanentPreviewStatusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentPreviewStatusError';
  }
}

function gridHref(
  profileId: string,
  period: { start: string; end: string },
  campaignId?: string,
): string {
  const parameters = new URLSearchParams({
    profile: profileId,
    entity: 'campaigns',
    from: period.start,
    to: period.end,
  });
  if (campaignId !== undefined) parameters.set('campaign', campaignId);
  return `/grid?${parameters.toString()}`;
}

function reviewHref(profileId: string, runId: string): string {
  return `/recommendations?${new URLSearchParams({ profile: profileId, run: runId }).toString()}`;
}

const METRIC_COLUMNS = allMetricColumns();

function metricColumn(id: string): GridColumn {
  const column = METRIC_COLUMNS.find((candidate) => candidate.id === id);
  if (column === undefined) throw new Error(`the optimizer grid asked for unknown metric '${id}'`);
  return column;
}

const dimension = (
  id: string,
  header: string,
  options: Partial<GridColumn> = {},
): GridColumn => ({ id, header, kind: 'dimension', scale: 'text', align: 'left', width: 160, ...options });

/**
 * The campaign grid's columns.
 *
 * Two are `control`: the selection checkbox and the recommendation link. They
 * hold a gesture, not a value, so they carry no ordering — the header offers no
 * `aria-sort` and a click on it does nothing (`packages/ui/src/columns.ts`).
 *
 * `spend_change` is a dimension rather than the metric model's
 * `spend_delta_percent` because the campaign loader returns prior-window
 * *spend* and nothing else. A `comparison` row would need all six base sums,
 * and filling the other five with zeros would put a plausible wrong number
 * (`Sales (prev) $0.00`) on every campaign. Grouped rows drop it and show `—`,
 * which is the truth: this figure exists per campaign, not per group.
 */
export function optimizerCampaignColumns(): GridColumn[] {
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
    dimension('campaign_name', 'Campaign', { width: 300, pinned: true }),
    dimension('group_name', 'Group', { width: 170, filterKind: 'categorical' }),
    dimension('campaign_state', 'State', { width: 100, filterKind: 'categorical' }),
    dimension('ad_product', 'Ad product', { width: 108, filterKind: 'categorical' }),
    metricColumn('spend'),
    dimension('spend_change', 'Spend Δ%', {
      scale: 'percent',
      align: 'right',
      width: 104,
      description:
        'Change against the comparison window’s spend for this campaign. Per campaign only: '
        + 'the loader returns prior spend and no other prior base sum, so a group shows no figure.',
    }),
    metricColumn('sales'),
    metricColumn('acos'),
    metricColumn('orders'),
    dimension('daily_budget', 'Daily budget', { scale: 'money', align: 'right', width: 118 }),
    dimension('bidding_strategy', 'Bid strategy', { width: 170, filterKind: 'categorical' }),
    dimension('start_date', 'Start', { width: 108 }),
    dimension('last_run_at', 'Last group run', { width: 136 }),
    {
      id: RECOMMENDATION_COLUMN_ID,
      header: 'Recommendation',
      kind: 'control',
      scale: 'text',
      align: 'left',
      width: 160,
    },
  ];
}

/**
 * One campaign as a grid row.
 *
 * Base sums only, as everywhere in the grid: ACOS is `sum(spend)/sum(sales)`
 * evaluated at whatever level is on screen, so grouping by state or ad product
 * cannot average a ratio. `comparison` is null because there is no comparison
 * base-sum row to carry; see `optimizerCampaignColumns`.
 */
export function toOptimizerGridRows(
  rows: readonly OptimizerCampaignRow[],
  currencyCode: string,
): GridRow[] {
  return rows.map((row) => ({
    id: row.campaignId,
    dimensions: {
      campaign_id: row.campaignId,
      campaign_name: row.name,
      campaign_state: titleCase(row.state),
      ad_product: row.adProduct,
      group_name: row.groupName,
      bidding_strategy: row.biddingStrategy === null ? null : titleCase(row.biddingStrategy),
      start_date: row.startDate,
      daily_budget: row.dailyBudget,
      // ISO, so a lexicographic sort is a chronological one; the cell formats it.
      last_run_at: row.lastRunAt,
      spend_change: spendChange(row),
    },
    totals: {
      impressions: row.impressions,
      clicks: row.clicks,
      spend: row.spend,
      sales: row.sales,
      orders: row.orders,
      units: 0,
    },
    comparison: null,
    currencyCode,
  }));
}

/** Relative spend change against the comparison window, or null when there is none. */
function spendChange(row: OptimizerCampaignRow): number | null {
  if (row.comparisonRows === 0 || row.comparisonSpend === 0) return null;
  return (row.spend - row.comparisonSpend) / row.comparisonSpend;
}

export function CampaignWorkspace({
  rows,
  currencyCode,
  profileId,
  period,
  run,
  mayRunOptimizer,
  previewReady,
  previewUnavailableMessage,
  profileToday,
  profileTimezone,
  initialBatchId,
  initialGridRect,
}: {
  rows: readonly OptimizerCampaignRow[];
  currencyCode: string;
  profileId: string;
  period: { start: string; end: string };
  run: { id: string; status: string } | null;
  mayRunOptimizer: boolean;
  previewReady: boolean;
  previewUnavailableMessage?: string;
  profileToday: string;
  profileTimezone: string;
  initialBatchId: string | null;
  /**
   * Test seam. The virtualizer measures a real element and jsdom has none, so
   * a unit test hands it one box. Production measures the viewport.
   */
  initialGridRect?: { width: number; height: number };
}): ReactNode {
  const router = useRouter();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState('all');
  const [state, setState] = useState('all');
  const [sort, setSort] = useState<SortRule[]>([...DEFAULT_SORT]);
  const [groupBy, setGroupBy] = useState<readonly string[]>([]);
  const [density, setDensity] = useState<GridDensity>(DEFAULT_DENSITY);
  const [fullscreen, setFullscreen] = useState(false);
  const [selectedCampaignIds, setSelectedCampaignIds] = useState<ReadonlySet<string>>(new Set());
  const [scopeMode, setScopeMode] = useState<ScopeMode>('all');
  const [submitting, setSubmitting] = useState(false);
  const [accepted, setAccepted] = useState<OptimizerPreviewAccepted | null>(null);
  const [activeBatchId, setActiveBatchId] = useState<string | null>(initialBatchId);
  const [batchStatus, setBatchStatus] = useState<OptimizerPreviewBatchStatus | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [deadlineReached, setDeadlineReached] = useState(false);
  const submitController = useRef<AbortController | null>(null);
  const submittingRef = useRef(false);
  const uncertainRequest = useRef<UncertainPreviewRequest | null>(null);
  const previousProfile = useRef(profileId);
  const filtered = useMemo(
    () => filterOptimizerCampaignRows(rows, { query, group, state }),
    [group, query, rows, state],
  );
  const eligibleRows = useMemo(() => rows.filter((row) => row.selectable), [rows]);
  const filteredEligibleRows = useMemo(
    () => filtered.filter((row) => row.selectable),
    [filtered],
  );
  const allFilteredSelected = filteredEligibleRows.length > 0
    && filteredEligibleRows.every((row) => selectedCampaignIds.has(row.campaignId));
  const someFilteredSelected = filteredEligibleRows
    .some((row) => selectedCampaignIds.has(row.campaignId));
  const groups = useMemo(
    () => [...new Map(rows.flatMap((row) => row.groupId === null || row.groupName === null
      ? []
      : [[row.groupId, row.groupName] as const])).entries()],
    [rows],
  );
  const states = useMemo(() => [...new Set(rows.map((row) => row.state))].sort(), [rows]);
  const assigned = rows.filter((row) => row.groupId !== null).length;
  const withProposals = rows.filter((row) => row.proposals > 0).length;
  const observedStatus = batchStatus?.status ?? accepted?.status ?? null;
  const batchActive = activeBatchId !== null
    && observedStatus !== 'succeeded'
    && observedStatus !== 'failed';
  const allModeTooLarge = eligibleRows.length > OPTIMIZER_PREVIEW_CAMPAIGN_MAX;
  const allModeInvalid = eligibleRows.length === 0 || allModeTooLarge;
  const selectionTooLarge = selectedCampaignIds.size > OPTIMIZER_PREVIEW_CAMPAIGN_MAX;
  const selectedModeInvalid = selectedCampaignIds.size === 0 || selectionTooLarge;
  const runDisabled = !mayRunOptimizer || !previewReady || submitting || batchActive
    || (scopeMode === 'all' ? allModeInvalid : selectedModeInvalid);
  const batchId = activeBatchId;
  const selectionLocked = !mayRunOptimizer || batchActive;

  const columns = useMemo(() => optimizerCampaignColumns(), []);
  const dimensions = useMemo(
    () => columns.filter((column) => column.kind === 'dimension'),
    [columns],
  );
  const gridRows = useMemo(
    () => toOptimizerGridRows(filtered, currencyCode),
    [currencyCode, filtered],
  );
  const model = useMemo(
    () => buildGridModel(gridRows, { sort, groupBy }),
    [gridRows, groupBy, sort],
  );
  const sourceById = useMemo(
    () => new Map(rows.map((row) => [row.campaignId, row] as const)),
    [rows],
  );
  const selectedRowIds = useMemo(() => [...selectedCampaignIds], [selectedCampaignIds]);
  // The grid distinguishes "the filter matched nothing" from "the period
  // produced nothing"; here the filter runs before the grid sees a row, so this
  // workspace decides which of the two it is and tells the grid once.
  const emptyGridMessage = rows.length === 0
    ? 'This profile has no campaigns yet. They arrive with the next entity sync.'
    : 'No campaigns match these filters.';

  useEffect(() => {
    if (previousProfile.current === profileId) return;
    previousProfile.current = profileId;
    submitController.current?.abort();
    submittingRef.current = false;
    setSelectedCampaignIds(new Set());
    setScopeMode('all');
    setSubmitting(false);
    setAccepted(null);
    setActiveBatchId(null);
    setBatchStatus(null);
    setAnnouncement('');
    setError(null);
    setDeadlineReached(false);
    uncertainRequest.current = null;
  }, [profileId]);

  useEffect(() => () => submitController.current?.abort(), []);

  useEffect(() => {
    if (batchId === null) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    let polling = false;
    let stopped = false;
    let delayIndex = 0;
    let observedVisibleMs = 0;
    let visibleStartedAt = document.visibilityState === 'hidden' ? null : Date.now();

    const stopTimer = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const stopDeadlineTimer = (): void => {
      if (deadlineTimer !== null) clearTimeout(deadlineTimer);
      deadlineTimer = null;
    };
    const reachDeadline = (): void => {
      stopped = true;
      stopTimer();
      stopDeadlineTimer();
      controller.abort();
      setDeadlineReached(true);
      setAnnouncement('Still running. Automatic status checks stopped after ten minutes; refresh this page or check Sync status.');
    };
    const remainingObservationMs = (): number => {
      const currentVisibleMs = visibleStartedAt === null ? 0 : Date.now() - visibleStartedAt;
      return POLL_DEADLINE_MS - observedVisibleMs - currentVisibleMs;
    };
    const armDeadline = (): void => {
      if (stopped || controller.signal.aborted || document.visibilityState === 'hidden') return;
      const remaining = remainingObservationMs();
      if (remaining <= 0) {
        reachDeadline();
        return;
      }
      stopDeadlineTimer();
      deadlineTimer = setTimeout(reachDeadline, remaining);
    };
    const schedule = (delay: number): void => {
      if (stopped || controller.signal.aborted || document.visibilityState === 'hidden') return;
      const remaining = remainingObservationMs();
      if (remaining <= 0) {
        reachDeadline();
        return;
      }
      stopTimer();
      timer = setTimeout(() => {
        timer = null;
        void poll();
      }, Math.min(delay, remaining));
    };
    const poll = async (): Promise<void> => {
      if (stopped || controller.signal.aborted || polling || document.visibilityState === 'hidden') return;
      if (remainingObservationMs() <= 0) {
        reachDeadline();
        return;
      }
      polling = true;
      try {
        const statusParameters = new URLSearchParams({ profileId });
        const statusPath = ['/api/optimizer/runs', encodeURIComponent(batchId)].join('/');
        const response = await fetch(`${statusPath}?${statusParameters.toString()}`, {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: controller.signal,
        });
        const payload = await response.json().catch(() => null) as unknown;
        if (!response.ok) {
          const message = optimizerPreviewError(payload, 'Preview status is unavailable.');
          if (response.status >= 400 && response.status < 500 && response.status !== 429) {
            throw new PermanentPreviewStatusError(message);
          }
          throw new Error(message);
        }
        let next: OptimizerPreviewBatchStatus;
        try {
          next = parseOptimizerPreviewStatus(payload);
        } catch (caught) {
          throw new PermanentPreviewStatusError(
            caught instanceof Error ? caught.message : 'The preview service returned invalid status.',
          );
        }
        if (next.batchId !== batchId) {
          throw new PermanentPreviewStatusError('The preview service returned a mismatched batch.');
        }
        setBatchStatus(next);
        setError(null);
        setAnnouncement(previewAnnouncement(next));
        if (next.status === 'succeeded' || next.status === 'failed') {
          stopped = true;
          stopTimer();
          stopDeadlineTimer();
          router.refresh();
          return;
        }
      } catch (caught) {
        if (controller.signal.aborted) return;
        if (caught instanceof PermanentPreviewStatusError) {
          stopped = true;
          stopTimer();
          stopDeadlineTimer();
          setActiveBatchId(null);
          forgetBatchInUrl();
          setError(caught.message);
          setAnnouncement('Automatic status checks stopped because this preview could not be read.');
          return;
        }
        setAnnouncement('Preview status is temporarily unavailable. Retrying automatically.');
      } finally {
        polling = false;
      }
      delayIndex = Math.min(delayIndex + 1, POLL_DELAYS_MS.length - 1);
      schedule(POLL_DELAYS_MS[delayIndex] as number);
    };
    const visibilityChanged = (): void => {
      if (document.visibilityState === 'hidden') {
        if (visibleStartedAt !== null) {
          observedVisibleMs += Date.now() - visibleStartedAt;
          visibleStartedAt = null;
        }
        stopTimer();
        stopDeadlineTimer();
      } else if (!stopped && !polling) {
        visibleStartedAt = Date.now();
        armDeadline();
        schedule(0);
      } else if (visibleStartedAt === null) {
        visibleStartedAt = Date.now();
        armDeadline();
      }
    };

    document.addEventListener('visibilitychange', visibilityChanged);
    armDeadline();
    schedule(POLL_DELAYS_MS[0]);
    return () => {
      stopped = true;
      stopTimer();
      stopDeadlineTimer();
      controller.abort();
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
  }, [batchId, profileId, router]);

  const toggleCampaign = useCallback((row: OptimizerCampaignRow): void => {
    if (!row.selectable || selectionLocked) return;
    setSelectedCampaignIds((current) => {
      const next = new Set(current);
      if (next.has(row.campaignId)) next.delete(row.campaignId);
      else next.add(row.campaignId);
      return next;
    });
    setScopeMode('selected');
    setError(null);
  }, [selectionLocked]);

  const toggleFilteredCampaigns = useCallback((): void => {
    if (selectionLocked || filteredEligibleRows.length === 0) return;
    setSelectedCampaignIds((current) => {
      const next = new Set(current);
      if (allFilteredSelected) {
        for (const row of filteredEligibleRows) next.delete(row.campaignId);
      } else {
        for (const row of filteredEligibleRows) next.add(row.campaignId);
      }
      return next;
    });
    setScopeMode('selected');
    setError(null);
  }, [allFilteredSelected, filteredEligibleRows, selectionLocked]);

  /**
   * The grid's own selection keys (Space toggles, Escape clears) come back
   * here. The grid does not know which campaigns may be previewed, so an
   * ineligible id is dropped rather than trusted: the checkbox and the keyboard
   * must never be able to disagree about what the scope contains.
   */
  const applyGridSelection = useCallback((rowIds: readonly string[]): void => {
    if (selectionLocked) return;
    const next = new Set<string>();
    for (const id of rowIds) {
      if (sourceById.get(id)?.selectable === true) next.add(id);
    }
    setSelectedCampaignIds(next);
    setScopeMode('selected');
    setError(null);
  }, [selectionLocked, sourceById]);

  function clearSelection(): void {
    setSelectedCampaignIds(new Set());
    setScopeMode('selected');
    setError(null);
  }

  const renderHeader = useMemo(
    () => ({
      [SELECT_COLUMN_ID]: () => (
        <input
          aria-label={`${allFilteredSelected ? 'Deselect' : 'Select'} all ${filteredEligibleRows.length.toLocaleString('en-US')} eligible campaigns matching current filters`}
          checked={allFilteredSelected}
          className="wa-checkbox"
          data-testid="optimizer-select-filtered"
          disabled={selectionLocked || filteredEligibleRows.length === 0}
          onChange={toggleFilteredCampaigns}
          ref={(element) => {
            if (element !== null) element.indeterminate = !allFilteredSelected && someFilteredSelected;
          }}
          type="checkbox"
        />
      ),
    }),
    [
      allFilteredSelected,
      filteredEligibleRows.length,
      selectionLocked,
      someFilteredSelected,
      toggleFilteredCampaigns,
    ],
  );

  const renderCell = useMemo(() => {
    /**
     * A campaign the period reported no row for has no figure, not a zero.
     * Amazon omits zero-impression rows, so `$0.00` here would be a
     * measurement this table never took — the same distinction the old table
     * kept by printing `—`. Returning `undefined` leaves every other row to
     * the grid's own formatter, and the group and totals rows are unaffected:
     * summing an absent row adds nothing either way.
     */
    const absentWithoutActivity = (gridRow: GridRow): ReactNode | undefined => {
      const source = sourceById.get(gridRow.id);
      if (source === undefined || source.currentRows !== 0) return undefined;
      return <span className="wa-hint">{EMPTY_CELL}</span>;
    };
    return {
      spend: absentWithoutActivity,
      spend_change: absentWithoutActivity,
      sales: absentWithoutActivity,
      acos: absentWithoutActivity,
      orders: absentWithoutActivity,
      [SELECT_COLUMN_ID]: (gridRow: GridRow) => {
        const source = sourceById.get(gridRow.id);
        if (source === undefined) return null;
        return (
          <input
            aria-describedby={source.eligibilityReason === null ? undefined : eligibilityId(source.campaignId)}
            aria-label={`Select ${source.name} for this preview`}
            checked={selectedCampaignIds.has(source.campaignId)}
            className="wa-checkbox"
            data-testid="optimizer-campaign-select"
            disabled={selectionLocked || !source.selectable}
            onChange={() => toggleCampaign(source)}
            type="checkbox"
          />
        );
      },
      campaign_name: (gridRow: GridRow) => {
        const source = sourceById.get(gridRow.id);
        if (source === undefined) return null;
        return (
          <span style={{ display: 'block', lineHeight: 1.15 }}>
            <a
              className="wa-optimizer-campaigns__name"
              href={gridHref(profileId, period, source.campaignId)}
              onClick={(event) => event.stopPropagation()}
            >
              {source.name}
            </a>
            {source.eligibilityReason === null ? null : (
              <span
                className="wa-optimizer-campaigns__ineligible"
                id={eligibilityId(source.campaignId)}
                style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                title={source.eligibilityReason}
              >
                {source.eligibilityReason}
              </span>
            )}
            {source.currentRows !== 0 ? null : (
              // Both notes, never one instead of the other: why a campaign
              // cannot be previewed and whether Amazon reported anything for it
              // are different facts, and a campaign is often both.
              <span className="wa-optimizer-campaigns__sub">No activity in this period</span>
            )}
          </span>
        );
      },
      group_name: (gridRow: GridRow) => {
        const source = sourceById.get(gridRow.id);
        if (source === undefined || source.groupName === null) {
          return <span className="wa-hint">Unassigned</span>;
        }
        return (
          <span className={`wa-cat wa-cat--${source.groupRole ?? 'unknown'}`}>{source.groupName}</span>
        );
      },
      last_run_at: (gridRow: GridRow) => {
        const source = sourceById.get(gridRow.id);
        return <>{source?.lastRunAt == null ? 'Never' : shortDate(source.lastRunAt)}</>;
      },
      [RECOMMENDATION_COLUMN_ID]: (gridRow: GridRow) => {
        const source = sourceById.get(gridRow.id);
        if (source !== undefined && source.proposals > 0 && run !== null) {
          return (
            <a
              className="wa-badge wa-badge--warn"
              href={reviewHref(profileId, run.id)}
              onClick={(event) => event.stopPropagation()}
            >
              {source.proposals} to review
            </a>
          );
        }
        return <span className="wa-hint">{recommendationState(run)}</span>;
      },
    };
  }, [
    period,
    profileId,
    run,
    selectedCampaignIds,
    selectionLocked,
    sourceById,
    toggleCampaign,
  ]);

  async function runPreview(configuration: OneTimeRpcConfiguration): Promise<void> {
    if (runDisabled || submittingRef.current) return;
    const campaignIds = [...selectedCampaignIds].sort();
    const scope = scopeMode === 'all'
      ? { mode: 'all' as const }
      : { mode: 'selected' as const, campaignIds };
    const scopeKey = JSON.stringify({ profileId, scope, configuration });
    const priorUncertain = uncertainRequest.current;
    const clientRequestId = priorUncertain?.scopeKey === scopeKey
      ? priorUncertain.clientRequestId
      : globalThis.crypto.randomUUID();
    const body = JSON.stringify({
      version: 1,
      configuration,
      profileId,
      clientRequestId,
      scope,
    });
    if (new TextEncoder().encode(body).byteLength > OPTIMIZER_PREVIEW_BODY_MAX_BYTES) {
      setError('The selected preview is too large. Narrow the selection or run all eligible campaigns.');
      return;
    }

    submitController.current?.abort();
    const controller = new AbortController();
    submitController.current = controller;
    submittingRef.current = true;
    setSubmitting(true);
    setAccepted(null);
    setActiveBatchId(null);
    setBatchStatus(null);
    setDeadlineReached(false);
    setAnnouncement('Queueing recommendation preview.');
    setError(null);
    try {
      const result = await postPreview(body, controller.signal);
      if (controller.signal.aborted) return;
      uncertainRequest.current = null;
      setSettingsOpen(false);
      setAccepted(result);
      setActiveBatchId(result.batchId);
      rememberBatchInUrl(result.batchId);
      setAnnouncement(`Preview queued for ${result.scope.campaignCount.toLocaleString('en-US')} campaigns across ${result.childCount.toLocaleString('en-US')} ${result.childCount === 1 ? 'run' : 'runs'}.`);
    } catch (caught) {
      if (controller.signal.aborted) return;
      uncertainRequest.current = caught instanceof UncertainPreviewResponseError
        ? { clientRequestId, scopeKey }
        : null;
      setAnnouncement(caught instanceof UncertainPreviewResponseError ? 'The preview response was interrupted; its saved status needs checking.' : 'Recommendation preview was not queued.');
      setError(caught instanceof Error ? caught.message : 'Recommendation preview could not be queued.');
    } finally {
      if (submitController.current === controller) submitController.current = null;
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <section className="wa-card wa-optimizer-campaigns" aria-labelledby="optimizer-campaigns-title">
      {settingsOpen ? <OneTimeSettingsDialog
        campaignCount={scopeMode === 'all' ? eligibleRows.length : selectedCampaignIds.size}
        settings={(scopeMode === 'all' ? eligibleRows : eligibleRows.filter((row) => selectedCampaignIds.has(row.campaignId))).map((row) => row.oneTimeSettings)}
        period={period} profileToday={profileToday} timezone={profileTimezone} currencyCode={currencyCode}
        submitting={submitting} submissionError={error}
        onClose={() => setSettingsOpen(false)} onConfirm={(configuration) => void runPreview(configuration)}
      /> : null}
      <header className="wa-card__head wa-optimizer-campaigns__head">
        <div>
          <h2 className="wa-card__title" id="optimizer-campaigns-title">Campaigns</h2>
          <p className="wa-card__sub">
            {rows.length} total · {eligibleRows.length} eligible · {assigned} assigned to a group · {withProposals} with a proposed change
          </p>
        </div>
        <div className="wa-row">
          <a className="wa-btn wa-btn--ghost wa-btn--sm" href={`/optimizer/groups?profile=${profileId}`}>
            Manage groups
          </a>
          <a className="wa-btn wa-btn--ghost wa-btn--sm" href={gridHref(profileId, period)}>
            Open full grid →
          </a>
        </div>
      </header>

      <div className="wa-optimizer-campaigns__toolbar" role="search" aria-label="Filter optimizer campaigns">
        <label className="wa-field wa-optimizer-campaigns__search">
          <span className="wa-label">Find campaign</span>
          <input
            aria-label="Find campaign"
            className="wa-input wa-input--sm"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Name or campaign ID"
            type="search"
            value={query}
          />
        </label>
        <label className="wa-field">
          <span className="wa-label">Optimization group</span>
          <select className="wa-select wa-select--sm" onChange={(event) => setGroup(event.target.value)} value={group}>
            <option value="all">All groups</option>
            <option value="unassigned">Unassigned</option>
            {groups.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
        <label className="wa-field">
          <span className="wa-label">Campaign state</span>
          <select className="wa-select wa-select--sm" onChange={(event) => setState(event.target.value)} value={state}>
            <option value="all">All states</option>
            {states.map((value) => <option key={value} value={value}>{titleCase(value)}</option>)}
          </select>
        </label>
        <span className="wa-optimizer-campaigns__shown" aria-live="polite">
          {filtered.length === rows.length
            ? `${filtered.length.toLocaleString('en-US')} ${filtered.length === 1 ? 'campaign' : 'campaigns'}`
            : `${filtered.length.toLocaleString('en-US')} of ${rows.length.toLocaleString('en-US')} campaigns`}
        </span>
        {query === '' && group === 'all' && state === 'all' ? null : (
          <button
            className="wa-btn wa-btn--ghost wa-btn--sm"
            onClick={() => { setQuery(''); setGroup('all'); setState('all'); }}
            type="button"
          >
            Clear filters
          </button>
        )}
      </div>

      <div className="wa-optimizer-preview" aria-busy={batchActive}>
        <fieldset className="wa-optimizer-preview__scope" aria-busy={batchActive}>
          <legend>Preview scope</legend>
          <label>
            <input
              checked={scopeMode === 'all'}
              className="wa-checkbox"
              disabled={!mayRunOptimizer || batchActive || allModeInvalid}
              name="optimizer-preview-scope"
              onChange={() => { setScopeMode('all'); setError(null); }}
              type="radio"
            />
            <span>All eligible campaigns ({eligibleRows.length.toLocaleString('en-US')})</span>
          </label>
          <label>
            <input
              checked={scopeMode === 'selected'}
              className="wa-checkbox"
              disabled={!mayRunOptimizer || batchActive || selectedCampaignIds.size === 0}
              name="optimizer-preview-scope"
              onChange={() => { setScopeMode('selected'); setError(null); }}
              type="radio"
            />
            <span>Selected campaigns ({selectedCampaignIds.size.toLocaleString('en-US')})</span>
          </label>
          <button
            className="wa-btn wa-btn--ghost wa-btn--sm"
            disabled={selectedCampaignIds.size === 0 || batchActive}
            onClick={clearSelection}
            type="button"
          >
            Clear selected
          </button>
        </fieldset>
        <div className="wa-optimizer-preview__action">
          <button
            aria-busy={submitting || batchActive}
            className="wa-btn wa-btn--primary wa-btn--sm"
            data-testid="optimizer-run-preview"
            disabled={runDisabled}
            onClick={() => { setError(null); setSettingsOpen(true); }}
            type="button"
          >
            {submitting
              ? 'Queueing preview…'
              : scopeMode === 'all'
                ? `Run preview · all ${eligibleRows.length.toLocaleString('en-US')}`
                : `Run preview · ${selectedCampaignIds.size.toLocaleString('en-US')} selected`}
          </button>
          <span className="wa-hint">Read-only preview · Amazon is not updated</span>
        </div>
        <p className="wa-optimizer-preview__selection" data-testid="optimizer-selection-count" aria-live="polite">
          {selectedCampaignIds.size === 0
            ? 'No campaigns selected.'
            : `${selectedCampaignIds.size.toLocaleString('en-US')} ${selectedCampaignIds.size === 1 ? 'campaign' : 'campaigns'} selected. Selections hidden by the current filters remain selected.`}
        </p>
        {!mayRunOptimizer ? (
          <p className="wa-optimizer-preview__permission">Your role can view previews but cannot queue one.</p>
        ) : !previewReady ? (
          <p className="wa-optimizer-preview__permission">
            {previewUnavailableMessage ?? 'Recommendation previews are temporarily unavailable.'}
          </p>
        ) : allModeTooLarge ? (
          <p className="wa-optimizer-preview__error" role="alert">
            One preview supports at most {OPTIMIZER_PREVIEW_CAMPAIGN_MAX.toLocaleString('en-US')} campaigns. Select a smaller campaign set.
          </p>
        ) : selectionTooLarge ? (
          <p className="wa-optimizer-preview__error" role="alert">
            Selected previews support at most {OPTIMIZER_PREVIEW_CAMPAIGN_MAX.toLocaleString('en-US')} campaigns. Narrow the selection.
          </p>
        ) : null}
        {error === null ? null : <p className="wa-optimizer-preview__error" role="alert">{error}</p>}
        <div className="wa-optimizer-preview__status" aria-live="polite" aria-atomic="true">
          {announcement}
          {deadlineReached ? <span> The preview may still complete in the background.</span> : null}
        </div>
        {batchStatus === null ? null : (
          <PreviewChildren profileId={profileId} status={batchStatus} />
        )}
      </div>

      {run?.status === 'succeeded' && withProposals === 0 ? (
        <div className="wa-optimizer-campaigns__run-note" role="status">
          <span aria-hidden="true">✓</span>
          <span><strong>No changes recommended in this run.</strong> Campaign performance remains available below.</span>
        </div>
      ) : null}

      <div aria-busy={batchActive} className="wa-optimizer-campaigns__grid">
      {/*
        * The measured fill always resolves to the floor on this page: the table
        * sits below the tile row and the trend chart, so the viewport is already
        * spent by the time the grid starts. The floor is therefore a real
        * decision rather than a safety net, and fullscreen is the gesture that
        * gives the table the whole screen.
        */}
      <GridViewport
        fullscreen={fullscreen}
        onExitFullscreen={() => setFullscreen(false)}
        minHeight={560}
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

        <DataGrid
          model={model}
          columns={columns}
          currencyCode={currencyCode}
          sort={sort}
          onSortChange={setSort}
          selectedRowIds={selectedRowIds}
          onSelectionChange={applyGridSelection}
          renderCell={renderCell}
          renderHeader={renderHeader}
          density={density}
          rowHeight={rowHeightFor(density, 2)}
          {...(initialGridRect === undefined ? {} : { initialRect: initialGridRect })}
          emptyMessage={emptyGridMessage}
          noDataMessage={emptyGridMessage}
        />
      </GridViewport>
      </div>
    </section>
  );
}

async function postPreview(body: string, signal: AbortSignal): Promise<OptimizerPreviewAccepted> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response: Response;
    try {
      response = await fetch('/api/optimizer/runs/one-time', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body,
        signal,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      if (attempt === 1) {
        throw new UncertainPreviewResponseError('The preview response was interrupted. Retry to check the same request safely.');
      }
      continue;
    }
    const payload = await response.json().catch(() => null) as unknown;
    if (!response.ok) {
      if (response.status >= 500 && attempt === 0) continue;
      if (response.status >= 500) {
        throw new UncertainPreviewResponseError(
          optimizerPreviewError(payload, 'The preview service did not confirm whether the request was queued. Retry safely.'),
        );
      }
      throw new Error(optimizerPreviewError(payload, 'Recommendation preview could not be queued.'));
    }
    try {
      return parseOptimizerPreviewAccepted(payload);
    } catch (error) {
      throw new UncertainPreviewResponseError(
        error instanceof Error ? error.message : 'The preview service returned an invalid acceptance response.',
      );
    }
  }
  throw new Error('Recommendation preview could not be queued.');
}

function rememberBatchInUrl(batchId: string): void {
  const parameters = new URLSearchParams(window.location.search);
  parameters.set('batch', batchId);
  const query = parameters.toString();
  window.history.replaceState(
    window.history.state,
    '',
    `${window.location.pathname}${query === '' ? '' : `?${query}`}${window.location.hash}`,
  );
}

function forgetBatchInUrl(): void {
  const parameters = new URLSearchParams(window.location.search);
  parameters.delete('batch');
  const query = parameters.toString();
  window.history.replaceState(
    window.history.state,
    '',
    `${window.location.pathname}${query === '' ? '' : `?${query}`}${window.location.hash}`,
  );
}

function PreviewChildren({
  profileId,
  status,
}: {
  profileId: string;
  status: OptimizerPreviewBatchStatus;
}): ReactNode {
  if (status.children.length === 0) return null;
  return (
    <>
    {status.executionSnapshot === undefined ? null : <p className="wa-hint">RPC · {status.executionSnapshot.configuration.window.start}–{status.executionSnapshot.configuration.window.end} · {status.executionSnapshot.profileTimezone} · target ACOS {status.executionSnapshot.configuration.targetAcos * 100}%</p>}
    <ul className="wa-optimizer-preview__children" aria-label="Preview runs">
      {status.children.map((child) => (
        <li key={child.runId}>
          <span>{child.groupName ?? 'Unassigned campaigns'} · {child.campaignCount.toLocaleString('en-US')} campaigns · {titleCase(child.outcome ?? child.status)}</span>
          {child.detail === undefined ? null : <span>{child.detail}</span>}
          {child.diagnostics === undefined ? null : <span>{child.diagnostics.targetsRead} targets read · {child.diagnostics.targetsConsidered} evaluated · {child.diagnostics.proposed} proposed · {child.diagnostics.suppressed + child.diagnostics.blockedOutOfStock} held · {child.diagnostics.declined} unchanged</span>}
          {child.status === 'succeeded' ? (
            <a href={reviewHref(profileId, child.runId)}>
              Review {child.proposalsCount.toLocaleString('en-US')} {child.proposalsCount === 1 ? 'recommendation' : 'recommendations'} →
            </a>
          ) : null}
        </li>
      ))}
    </ul>
    </>
  );
}

function previewAnnouncement(status: OptimizerPreviewBatchStatus): string {
  if ((status.status === 'queued' || status.status === 'running') && status.availability?.ready === false) {
    return `Preview saved. ${oneTimePreviewUnavailableMessage(status.availability.reason)}`;
  }
  if (status.status === 'queued') {
    return `Preview queued for ${status.campaignCount.toLocaleString('en-US')} campaigns.`;
  }
  if (status.status === 'running') {
    return `Preview running for ${status.campaignCount.toLocaleString('en-US')} campaigns.`;
  }
  if (status.status === 'failed') {
    return `Preview failed. ${status.proposalsCount.toLocaleString('en-US')} ${status.proposalsCount === 1 ? 'recommendation remains' : 'recommendations remain'} available from completed runs.`;
  }
  return status.proposalsCount === 0
    ? 'Preview completed. No changes were recommended.'
    : `Preview completed with ${status.proposalsCount.toLocaleString('en-US')} ${status.proposalsCount === 1 ? 'recommendation' : 'recommendations'} to review.`;
}

function recommendationState(run: { status: string } | null): string {
  if (run === null) return 'Not run';
  if (run.status === 'queued' || run.status === 'running') return 'Pending';
  if (run.status === 'failed') return 'Run failed';
  return 'No change';
}

/** The id the ineligibility note carries so its checkbox can describe itself. */
function eligibilityId(campaignId: string): string {
  return `optimizer-campaign-${campaignId}-eligibility`;
}

function shortDate(value: string): string {
  return new Intl.DateTimeFormat('en-US', { day: 'numeric', month: 'short', timeZone: 'UTC' })
    .format(new Date(value));
}

function titleCase(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}
