import type { MarketProximityAlert, MarketRankPoint, MarketRankSeries } from '@wizard-ads/shared';

const dayBefore = (date: string): string => new Date(Date.parse(`${date}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
const measured = (value: number | null | undefined): value is number => value !== null && value !== undefined && Number.isInteger(value) && value > 0;

/** Fill every calendar day explicitly. Chart consumers must retain these nulls. */
export function marketRankWindow(points: readonly MarketRankPoint[], start: string, end: string): MarketRankPoint[] {
  const ranks = new Map(points.map((point) => [point.date, point.bsr]));
  const result: MarketRankPoint[] = [];
  for (let time = Date.parse(`${start}T00:00:00Z`); time <= Date.parse(`${end}T00:00:00Z`); time += 86_400_000) {
    const date = new Date(time).toISOString().slice(0, 10);
    const rank = ranks.get(date);
    result.push({ date, bsr: measured(rank) ? rank : null });
  }
  return result;
}

/**
 * Proximity is an inclusive distance on either side of our rank, as a percentage
 * of our BSR. Cause compares adjacent calendar days; missing evidence never alerts.
 * A null cause means neither adverse movement happened (stable or widening gap).
 * Exported for the Home block as well as Market position.
 */
export function marketPositionAlerts(own: MarketRankSeries, competitor: MarketRankSeries, thresholdPercent: number): MarketProximityAlert[] {
  if (!Number.isFinite(thresholdPercent) || thresholdPercent < 0 || thresholdPercent > 100 || !own.category || own.category !== competitor.category || own.asin === competitor.asin) return [];
  const ours = new Map(own.points.map((point) => [point.date, point.bsr]));
  const theirs = new Map(competitor.points.map((point) => [point.date, point.bsr]));
  return [...ours].sort(([a], [b]) => a.localeCompare(b)).flatMap(([date, ownBsr]) => {
    const competitorBsr = theirs.get(date);
    const priorOwn = ours.get(dayBefore(date));
    const priorCompetitor = theirs.get(dayBefore(date));
    if (!measured(ownBsr) || !measured(competitorBsr) || !measured(priorOwn) || !measured(priorCompetitor)) return [];
    const gap = competitorBsr - ownBsr;
    if (Math.abs(gap) * 100 > ownBsr * thresholdPercent) return [];
    const slipped = ownBsr > priorOwn;
    const gained = competitorBsr < priorCompetitor;
    return [{ date, ownAsin: own.asin, competitorAsin: competitor.asin, category: own.category,
      ownBsr, competitorBsr, gap, gapPercent: gap / ownBsr * 100,
      cause: slipped && gained ? 'both' as const : slipped ? 'own_rank_worsened' as const : gained ? 'competitor_improved' as const : null }];
  });
}

/** Signed rank distance to the best-ranked tracked competitor on this exact day. */
export function marketPositionGap(own: MarketRankSeries, competitors: readonly MarketRankSeries[], date: string): number | null {
  const rank = own.points.find((point) => point.date === date)?.bsr;
  if (!measured(rank) || !own.category) return null;
  const ranks = competitors.filter((series) => series.category === own.category && series.asin !== own.asin)
    .map((series) => series.points.find((point) => point.date === date)?.bsr).filter(measured);
  return ranks.length ? Math.min(...ranks) - rank : null;
}
