/**
 * The summary strip's rule (WP-321): a window total is the aggregate of the
 * measured facts of the rows that reported in that window.
 *
 * `grandTotal` in `@wizard-ads/ui` unions every row's `missing` list into the
 * total. That is right for a row that reported without a figure, and wrong for a
 * row that did not report at all: a campaign listed only for its comparison
 * facts marked all six bases missing and blanked every card, and one campaign
 * without comparison facts blanked every comparison. Here a row counts for a
 * window only when it has facts there: current facts unless the row is
 * `unreported`, comparison facts unless its comparison is null.
 *
 * A window has no total only when no matched row reported in it. The card then
 * says why in one sentence: the source holds no facts for the window (and since
 * when it does), or it does and none of these rows reported. A reported row
 * that lacks one base still blanks that base, and every ratio built on it, with
 * the count of rows that lack it. Nothing here renders null as zero.
 */
// Group subtotals still use the ui union rule in `aggregate.ts`; WP-316 owns moving them to this one.
import { BASE_METRICS, addTotals, emptyTotals, grandTotal, metricSpec, resolveField, type BaseMetric, type BaseTotals, type EntityLevel, type GridRow, type GroupedRow, type MetricScale } from '@wizard-ads/ui';
import { GRID_CHART_SERIES, GRID_SUMMARY_METRICS, type GridChartSeries, type GridMeasurement, type GridSummaryEvidence, type GridSummaryMetric, type GridSummarySource } from '@wizard-ads/shared';
import { formatDateWindow, formatShellDate } from '../../ui/date-format';

/** The strip before any customization: unchanged from the performance frame. */
export const DEFAULT_SUMMARY_METRICS: readonly GridSummaryMetric[] = ['impressions', 'clicks', 'spend', 'sales', 'orders', 'acos', 'cvr', 'cpc'];

/** The metrics a card can chart: the saved view's chart series, from the shared contract. */
export const CHARTABLE_SUMMARY_METRICS: readonly GridChartSeries[] = GRID_CHART_SERIES;
export function isChartable(key: GridSummaryMetric): key is GridChartSeries {
  return (CHARTABLE_SUMMARY_METRICS as readonly string[]).includes(key);
}

/** Only catalogue metrics, once each, in the saved order; the default set when none remain. */
export function summaryMetrics(saved: readonly string[] | undefined): readonly GridSummaryMetric[] {
  const valid = [...new Set(saved ?? [])].filter((key): key is GridSummaryMetric => (GRID_SUMMARY_METRICS as readonly string[]).includes(key));
  return valid.length ? valid : DEFAULT_SUMMARY_METRICS;
}

const NOUNS: Record<EntityLevel, readonly [string, string]> = {
  campaigns: ['campaign', 'campaigns'], ad_groups: ['ad group', 'ad groups'], targets: ['target', 'targets'],
  search_terms: ['search term', 'search terms'], products: ['product', 'products'], placements: ['placement row', 'placement rows'],
};
/** Each source as a sentence subject and mid-sentence. */
const SOURCES: Record<GridSummarySource, readonly [string, string]> = {
  sp_target: ['Sponsored Products target facts', 'Sponsored Products target facts'],
  search_term: ['Search term facts', 'search term facts'],
  placement: ['Placement facts', 'placement facts'],
  advertised_product: ['Advertised product facts', 'advertised product facts'],
};

export type SummaryWindowName = 'current' | 'comparison';
export type SummaryAbsence = 'no-rows' | 'no-facts' | 'not-measured' | 'off';

export interface SummaryWindow {
  /** Matched rows with facts in this window. */
  reported: number;
  /** For each base, how many reported rows lack it. */
  missing: Partial<Record<BaseMetric, number>>;
  /** Why the window has no total at all; null when it has one. */
  absence: { kind: SummaryAbsence; reason: string } | null;
  /** A measured window that reaches outside the source's held dates. */
  note: string | null;
}

export interface SummarySide {
  value: number | null;
  /** One sentence whenever `value` is null. */
  reason: string | null;
  /** True only when the window's source is genuinely absent. */
  notMeasured: boolean;
  note: string | null;
}

export interface SummaryCard {
  key: GridSummaryMetric;
  label: string;
  scale: MetricScale;
  better: 'higher' | 'lower' | null;
  current: SummarySide;
  prior: SummarySide;
  /** Percent change against the comparison; null when either side is unknown or the prior is zero. */
  delta: number | null;
}

export interface GridSummary {
  total: GroupedRow | null;
  current: SummaryWindow;
  comparison: SummaryWindow;
  cards: SummaryCard[];
}

function reportedIn(row: GridRow, window: SummaryWindowName): boolean {
  return window === 'current' ? row.measurement?.unreported !== true : row.comparison !== null;
}

type WindowCounts = Pick<SummaryWindow, 'reported' | 'missing'>;

function missingCounts(rows: readonly GridRow[], window: SummaryWindowName): WindowCounts {
  let reported = 0;
  const missing: Partial<Record<BaseMetric, number>> = {};
  for (const row of rows) {
    if (!reportedIn(row, window)) continue;
    reported += 1;
    for (const key of (window === 'current' ? row.measurement?.missing : row.measurement?.comparisonMissing) ?? []) {
      missing[key] = (missing[key] ?? 0) + 1;
    }
  }
  return { reported, missing };
}

function windowMissing(counts: WindowCounts): BaseMetric[] {
  return counts.reported === 0 ? [...BASE_METRICS] : BASE_METRICS.filter((key) => (counts.missing[key] ?? 0) > 0);
}

/**
 * The grand total under the window rule. Each window sums only the rows that
 * reported in it, whatever placeholders the others carry, and its measurement
 * is rebuilt from those rows. `grandTotal` supplies the row shape and refuses
 * mixed currencies.
 */
export function windowTotal(rows: readonly GridRow[]): GroupedRow | null {
  return totalWith(rows, missingCounts(rows, 'current'), missingCounts(rows, 'comparison'));
}

function totalWith(rows: readonly GridRow[], current: WindowCounts, comparison: WindowCounts): GroupedRow | null {
  const total = grandTotal(rows);
  if (total === null) return null;
  const totals = emptyTotals();
  let prior: BaseTotals | null = null;
  for (const row of rows) {
    if (reportedIn(row, 'current')) addTotals(totals, row.totals);
    if (row.comparison !== null) {
      prior ??= emptyTotals();
      addTotals(prior, row.comparison);
    }
  }
  const missing = windowMissing(current);
  const comparisonMissing = windowMissing(comparison);
  const { measurement: _union, ...rest } = total;
  const measurement: GridMeasurement = { missing, comparisonMissing };
  const summed = { ...rest, totals, comparison: prior };
  return missing.length || comparisonMissing.length ? { ...summed, measurement } : summed;
}

function windowName(window: SummaryWindowName, evidence: GridSummaryEvidence | undefined): string {
  const name = window === 'current' ? 'this range' : 'the comparison range';
  const dates = evidence === undefined ? null : window === 'current' ? evidence.period : evidence.comparison;
  return dates === null ? name : `${name} (${formatDateWindow(dates.start, dates.end)})`;
}

function assessWindow(rows: readonly GridRow[], window: SummaryWindowName, counts: WindowCounts, input: SummaryInput): SummaryWindow {
  const evidence = input.evidence;
  const [singular, plural] = NOUNS[input.entity];
  const named = windowName(window, evidence);
  if (window === 'comparison' && input.comparisonOff) return { ...counts, absence: { kind: 'off', reason: 'Comparison is off.' }, note: null };
  const dates = evidence === undefined ? null : window === 'current' ? evidence.period : evidence.comparison;
  const [source, sourceInSentence] = evidence === undefined ? [null, null] : SOURCES[evidence.source];
  if (counts.reported > 0) {
    let note: string | null = null;
    if (evidence !== undefined && dates !== null && source !== null && evidence.heldFrom !== null && evidence.heldThrough !== null) {
      if (evidence.heldFrom > dates.start) note = `${source} are held from ${formatShellDate(evidence.heldFrom)}, so ${named} is only partly covered.`;
      else if (evidence.heldThrough < dates.end) note = `${source} are held only through ${formatShellDate(evidence.heldThrough)}, so ${named} is only partly covered.`;
    }
    return { ...counts, absence: null, note };
  }
  // Evidence first: an absent source is "not measured" even when no row is left to show.
  if (evidence !== undefined && dates !== null && source !== null) {
    if (evidence.heldFrom === null || evidence.heldThrough === null) {
      return { ...counts, absence: { kind: 'not-measured', reason: `This profile holds no ${sourceInSentence} yet.` }, note: null };
    }
    if (dates.end < evidence.heldFrom) {
      return { ...counts, absence: { kind: 'not-measured', reason: `${source} are held from ${formatShellDate(evidence.heldFrom)}, after ${named} ends.` }, note: null };
    }
    if (dates.start > evidence.heldThrough) {
      return { ...counts, absence: { kind: 'not-measured', reason: `${source} are held only through ${formatShellDate(evidence.heldThrough)}, before ${named} starts.` }, note: null };
    }
  }
  // The source reaches this window (or no evidence came with the rows): the view's filter left nothing.
  if (rows.length === 0) return { ...counts, absence: { kind: 'no-rows', reason: `No ${plural} match this view.` }, note: null };
  const reason = rows.length === 1
    ? `The one ${singular} in this view has no facts for ${named}.`
    : `None of the ${rows.length} ${plural} in this view has facts for ${named}.`;
  return { ...counts, absence: { kind: 'no-facts', reason }, note: null };
}

function side(total: GroupedRow | null, key: GridSummaryMetric, window: SummaryWindow, part: SummaryWindowName, named: string, entity: EntityLevel): SummarySide {
  if (window.absence !== null) return { value: null, reason: window.absence.reason, notMeasured: window.absence.kind === 'not-measured', note: null };
  const raw = total === null ? null : resolveField(total, part === 'current' ? key : `${key}_comparison`);
  const value = typeof raw === 'number' ? raw : null;
  return { value, reason: value === null ? unknownReason(key, window, named, entity) : null, notMeasured: false, note: window.note };
}

function unknownReason(key: GridSummaryMetric, window: SummaryWindow, named: string, entity: EntityLevel): string {
  const spec = metricSpec(key)!;
  const operands: BaseMetric[] = spec.derived === null ? [key as BaseMetric] : [spec.derived.numerator, spec.derived.denominator];
  const [, plural] = NOUNS[entity];
  const lacking = operands.find((base) => (window.missing[base] ?? 0) > 0);
  if (lacking !== undefined) {
    const label = metricSpec(lacking)!.label;
    return `${label} is missing for ${window.missing[lacking]} of ${window.reported} ${plural} with facts in ${named}, so ${lacking === key ? 'no total is shown' : `${spec.label} has no total`}.`;
  }
  const denominator = spec.derived === null ? null : metricSpec(spec.derived.denominator)!.label.toLowerCase();
  return denominator === null ? `No total is available for ${named}.` : `${spec.label} is undefined because the ${denominator} total is zero in ${named}.`;
}

export interface SummaryInput {
  entity: EntityLevel;
  metrics: readonly GridSummaryMetric[];
  evidence?: GridSummaryEvidence | undefined;
  /** The operator switched the comparison off; rows then carry no comparison. */
  comparisonOff?: boolean;
}

export function summarizeGrid(rows: readonly GridRow[], input: SummaryInput): GridSummary {
  const counted = { current: missingCounts(rows, 'current'), comparison: missingCounts(rows, 'comparison') };
  const total = totalWith(rows, counted.current, counted.comparison);
  const current = assessWindow(rows, 'current', counted.current, input);
  const comparison = assessWindow(rows, 'comparison', counted.comparison, input);
  const currentName = windowName('current', input.evidence);
  const comparisonName = windowName('comparison', input.evidence);
  const cards = input.metrics.map((key): SummaryCard => {
    const spec = metricSpec(key)!;
    const now = side(total, key, current, 'current', currentName, input.entity);
    const prior = side(total, key, comparison, 'comparison', comparisonName, input.entity);
    const delta = now.value === null || prior.value === null || prior.value === 0 ? null : (now.value - prior.value) / Math.abs(prior.value) * 100;
    return { key, label: spec.label, scale: spec.scale, better: spec.better, current: now, prior, delta };
  });
  return { total, current, comparison, cards };
}
