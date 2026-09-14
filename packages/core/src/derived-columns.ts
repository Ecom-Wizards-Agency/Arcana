/** Performance ratios use fractions. Missing evidence or a zero denominator stays null. */
const finite = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value);

export function grossBreakEvenBid(cpc: number | null, acos: number | null): number | null {
  return finite(cpc) && cpc >= 0 && finite(acos) && acos > 0 ? cpc / acos : null;
}

export function topOfSearchRange(days: readonly (number | null)[]): { low: number; high: number } | null {
  const values = days.filter((value): value is number => finite(value) && value >= 0 && value <= 1);
  return values.length ? { low: Math.min(...values), high: Math.max(...values) } : null;
}

/** Positive means an improvement: rank 8 to rank 3 is +5. */
export function rankChange(current: number | null, previous: number | null): number | null {
  return finite(current) && current > 0 && finite(previous) && previous > 0 ? previous - current : null;
}

/** Difference in percentage points, not a relative percent change. */
export function acosVsTarget(acos: number | null, target: number | null): number | null {
  return finite(acos) && finite(target) ? (acos - target) * 100 : null;
}

export function shareOfSpend(spend: number | null, total: number | null): number | null {
  return finite(spend) && spend >= 0 && finite(total) && total > 0 ? spend / total : null;
}

export function conversionPoints(asinConversion: number | null, marketConversion: number | null): number | null {
  return finite(asinConversion) && finite(marketConversion) ? (asinConversion - marketConversion) * 100 : null;
}
