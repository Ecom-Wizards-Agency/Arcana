import type { CoreReportRow } from '@wizard-ads/shared';

/** A missing numerator/denominator makes a ratio unmeasured, including within partial sums. */
export function aggregateReportMetrics(rows: readonly CoreReportRow[], numerator: string, denominator: string): { numerator: number | null; denominator: number | null; ratio: number | null } {
  const first = rows[0];
  if (rows.some((row) => row.family !== first?.family || row.timeUnit !== first.timeUnit || row.attributionGeneration !== first.attributionGeneration)) throw new Error('incompatible report metric grains or attribution generations');
  const sum = (key: string): number | null => rows.length === 0 || rows.some((row) => row.metrics[key] == null) ? null : rows.reduce((total, row) => total + row.metrics[key]!, 0);
  const n = sum(numerator), d = sum(denominator);
  return { numerator: n, denominator: d, ratio: n === null || d === null || d === 0 ? null : n / d };
}
