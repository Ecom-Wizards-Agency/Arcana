/**
 * Freshness comes from coverage observations or the legacy request ledger, never fact timestamps.
 * WP-324: where a coverage row records the days completed loads returned, coverage reaches the
 * newest held day, and a source with no held day is not measured.
 */
import type { FreshnessCoverage, FreshnessLedgerEntry, VerifiedCoverageSpan } from '@wizard-ads/shared';
import { formatInteger } from '../format.js';

export type FreshnessTone = 'good' | 'warn' | 'bad' | 'muted';

export type ReportLedgerEntry = FreshnessLedgerEntry;

export interface FreshnessAssessment {
  tone: FreshnessTone;
  headline: string;
  /** One line per report type, newest first. */
  details: string[];
  /** Report types whose newest successful load is older than the threshold. */
  staleTypes: string[];
  /** Report types whose last load parsed more rows than it wrote. */
  lossyTypes: string[];
  /**
   * Newest day held across every completed report: the verified span's last day where the
   * source records one, otherwise the load's end date.
   */
  coversThrough: string | null;
}

/** Undefined: no verified span recorded. Null: recorded, with no day held. */
type AssessedEntry = ReportLedgerEntry & { verified?: VerifiedCoverageSpan | null };

export interface FreshnessOptions {
  /** Evaluation instant. Injected so the assessment is testable. */
  now: Date;
  /**
   * Hours after which a completed load counts as stale. 30 by default: a daily
   * sync that ran yesterday is fine, one that last ran the day before is not.
   */
  staleAfterHours?: number;
}

const HOUR_MS = 3_600_000;

export function assessFreshness(
  entries: readonly (ReportLedgerEntry | FreshnessCoverage)[],
  options: FreshnessOptions,
): FreshnessAssessment {
  if (entries.length === 0) {
    return {
      tone: 'muted',
      headline: 'No report has ever been requested for this profile.',
      details: [
        'Freshness is read from the report ledger, not from the fact tables: with no ledger row ' +
          'there is nothing to be fresh or stale.',
      ],
      staleTypes: [],
      lossyTypes: [],
      coversThrough: null,
    };
  }

  const staleAfter = (options.staleAfterHours ?? 30) * HOUR_MS;
  const byType = new Map<string, AssessedEntry[]>();
  for (const input of entries) {
    const entry: AssessedEntry = 'coveredThrough' in input ? {
      reportType: `${input.source}/${input.reportType}`,
      status: input.status === 'complete' && input.coveredThrough !== null ? 'completed' : input.status,
      endDate: input.coveredThrough ?? '',
      requestedAt: input.observedAt,
      completedAt: input.status === 'complete' ? input.observedAt : null,
      rowsParsed: input.parsedRows,
      rowsLoaded: input.loadedRows,
      countsMatch: input.countsMatch,
      error: null,
      ...(input.verified === undefined ? {} : { verified: input.verified }),
    } : input.source === undefined ? input : { ...input, reportType: `${input.source}/${input.reportType}` };
    const bucket = byType.get(entry.reportType);
    if (bucket === undefined) byType.set(entry.reportType, [entry]);
    else bucket.push(entry);
  }

  const details: string[] = [];
  const staleTypes: string[] = [];
  const lossyTypes: string[] = [];
  const failedTypes: string[] = [];
  const unmeasuredTypes: string[] = [];
  let coversThrough: string | null = null;

  for (const [reportType, rows] of [...byType].sort(([a], [b]) => a.localeCompare(b))) {
    const newest = [...rows].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))[0];
    const lastGood = [...rows]
      .filter((row) => row.status === 'completed' && row.completedAt !== null)
      .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))[0];

    if (lastGood === undefined) {
      failedTypes.push(reportType);
      details.push(
        `${reportType}: never completed — newest attempt ${newest?.status ?? 'unknown'}` +
          (newest?.error ? ` (${newest.error})` : ''),
      );
      continue;
    }

    // Coverage is the furthest day ANY completed load reached, not the end
    // date of the newest completion: a backfill that finishes an old window
    // last must not drag "covers through" backwards. A recorded verified span
    // reaches only its newest held day; a requested range alone reaches nothing.
    const completed = rows.filter((row) => row.status === 'completed');
    // The span that reaches furthest describes the type; spans of sibling grains are not summed.
    const span = completed.flatMap((row) => row.verified ? [row.verified] : [])
      .sort((a, b) => b.through.localeCompare(a.through) || b.daysHeld - a.daysHeld)[0];
    const coveredThrough = completed
      .map((row) => row.verified === undefined ? row.endDate : row.verified?.through ?? null)
      .reduce<string | null>((acc, through) => through !== null && (acc === null || through > acc) ? through : acc, null);
    if (coveredThrough === null) unmeasuredTypes.push(reportType);
    else if (coversThrough === null || coveredThrough > coversThrough) coversThrough = coveredThrough;

    const ageMs = options.now.getTime() - new Date(lastGood.completedAt as string).getTime();
    const stale = ageMs > staleAfter;
    if (stale) staleTypes.push(reportType);

    // Rule 45 surfaced where an operator sees it: a load that parsed more rows
    // than it wrote is a silent data loss, and the banner is the only place it
    // would ever be noticed.
    if (lastGood.countsMatch === false) lossyTypes.push(reportType);

    details.push(
      `${reportType}: loaded ${formatAge(ageMs)} ago, ` +
        (coveredThrough === null ? 'not measured: no returned day held yet' : `covers through ${coveredThrough}`) +
        (span === undefined ? '' : `, ${formatInteger(span.daysHeld)} ${span.daysHeld === 1 ? 'day' : 'days'} held since ${span.from}` +
          (span.gapDays === 0 ? '' : ` (${formatInteger(span.gapDays)} not loaded)`)) +
        (lastGood.rowsLoaded === null ? '' : `, ${formatInteger(lastGood.rowsLoaded)} rows`) +
        (lastGood.countsMatch === false
          ? ` — parsed ${count(lastGood.rowsParsed)}, wrote ${count(lastGood.rowsLoaded)}`
          : '') +
        (newest !== undefined && newest.status !== 'completed' ? ` · newest attempt ${newest.status}` : ''),
    );
  }

  if (failedTypes.length > 0) {
    return {
      tone: 'bad',
      headline: `No completed load for ${failedTypes.join(', ')}. The figures below are older than this page.`,
      details,
      staleTypes,
      lossyTypes,
      coversThrough,
    };
  }
  if (lossyTypes.length > 0) {
    return {
      tone: 'bad',
      headline: `Row loss on ${lossyTypes.join(', ')}: the file held more rows than reached the fact tables.`,
      details,
      staleTypes,
      lossyTypes,
      coversThrough,
    };
  }
  if (staleTypes.length > 0) {
    return {
      tone: 'warn',
      headline: `Stale: ${staleTypes.join(', ')} has not loaded successfully in over ${options.staleAfterHours ?? 30} hours.`,
      details,
      staleTypes,
      lossyTypes,
      coversThrough,
    };
  }
  if (coversThrough === null) {
    return {
      tone: 'muted',
      headline: `Not measured: completed loads for ${unmeasuredTypes.join(', ')} have returned no day to hold.`,
      details,
      staleTypes,
      lossyTypes,
      coversThrough,
    };
  }

  return {
    tone: 'good',
    headline: `Fresh${coversThrough === null ? '' : ` · covers through ${coversThrough}`}.`,
    details,
    staleTypes,
    lossyTypes,
    coversThrough,
  };
}

const count = (value: number | null): string => (value === null ? '?' : formatInteger(value));

function formatAge(ms: number): string {
  const hours = ms / HOUR_MS;
  if (hours < 1) return `${Math.max(1, Math.round(ms / 60_000))} min`;
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${Math.round(hours / 24)} days`;
}
