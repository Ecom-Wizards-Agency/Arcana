import type { TargetCorridorPoint, TargetBidContext, QueuedBidCheck } from '@wizard-ads/shared';

export function corridorMaxCpc(base: number | null, components: readonly { name: string; pct: number }[]): number | null {
  if (base === null || components.length === 0) return null;
  return base * (1 + Math.max(...components.map((component) => component.pct)) / 100);
}
export function corridorSummary(points: readonly TargetCorridorPoint[]) {
  const last = points.at(-1);
  const cpcs = points.filter((p) => p.cpc !== null);
  const highest = cpcs.reduce<TargetCorridorPoint | null>((best, p) => best === null || p.cpc! > best.cpc! ? p : best, null);
  const comparable = points.filter((p) => p.bid !== null && p.low !== null && p.high !== null);
  const below = comparable.filter((p) => p.bid! < p.low!).length;
  const above = comparable.filter((p) => p.bid! > p.high!).length;
  const medians = points.filter((p) => p.median !== null);
  const previousMedian = medians.find((p) => p.median !== medians.at(-1)?.median) ?? null;
  return {
    bid: last?.bid ?? null, median: last?.median ?? null, maxCpc: last?.maxCpc ?? null,
    cpcAverage: cpcs.length === 0 ? null : cpcs.reduce((sum, p) => sum + p.cpc!, 0) / cpcs.length,
    highestCpc: highest?.cpc ?? null, highestDate: highest?.date ?? null,
    below, above, comparable: comparable.length, previousMedian,
    bandPosition: comparable.length === 0 ? 'Not measured' : below > 0 ? `Below on ${below} of ${comparable.length}` : above > 0 ? `Above on ${above} of ${comparable.length}` : `Within on ${comparable.length} of ${comparable.length}`,
  };
}
export function corridorReading(points: readonly TargetCorridorPoint[], money: (value: number) => string): string {
  const s = corridorSummary(points);
  if (points.length === 0) return 'No corridor series has been measured. There is no basis for a bid reading.';
  if (s.highestCpc === null) return 'Realised CPC is not measured. The suggested range alone does not establish the cost of a click.';
  const cost = `The highest measured CPC was ${money(s.highestCpc)} on ${s.highestDate}.`;
  if (s.median === null) return `${cost} The suggested median is not measured, so its distance from CPC cannot be assessed.`;
  if (s.median > s.highestCpc) return `Amazon suggested ${money(s.median)}; ${cost.charAt(0).toLowerCase()}${cost.slice(1)} Review placement exposure before matching the suggestion.`;
  if (s.above > 0) return `${s.bandPosition}. ${cost} Review the bid against placement exposure and campaign limits.`;
  return `${s.bandPosition}. ${cost} The suggested median is ${money(s.median)}. These observations do not authorize a bid change.`;
}
/** UI preview only. The database recomputes these checks when admitting a proposal. */
export function targetBidChecks(c: TargetBidContext, bid: number, overrideReason: string | null): QueuedBidCheck[] {
  const old = c.oldBid === null ? null : Number(c.oldBid.amount);
  const down = old !== null && bid < old;
  const rankKnown = c.organicRank !== null && c.protectionRank !== null;
  const protectedRank = rankKnown && c.organicRank! <= c.protectionRank!;
  const rankPass = !down || (rankKnown && (!protectedRank || Boolean(overrideReason?.trim())));
  const placementsKnown = c.placementModifiers !== null && Object.values(c.placementModifiers).every((value) => value !== null);
  const delta = old === null || old <= 0 ? null : (bid - old) / old;
  return [
    { key: 'rank_gate', passed: rankPass, source: 'rank_observations · profile strategy', reason: !down ? 'No bid decrease.' : !rankKnown ? 'Rank protection setting or observation is not measured.' : protectedRank ? overrideReason?.trim() ? `Rank gate override: ${overrideReason.trim()}` : 'Protected organic rank: record an override reason before reducing the bid.' : 'Organic rank is outside the configured protection rank.' },
    { key: 'band_position', passed: c.suggestedLow !== null && c.suggestedHigh !== null && bid >= c.suggestedLow && bid <= c.suggestedHigh, source: 'bid_series_daily', reason: c.suggestedLow === null || c.suggestedHigh === null ? 'Suggested band is not measured.' : bid < c.suggestedLow ? 'Proposed bid is below the suggested band.' : bid > c.suggestedHigh ? 'Proposed bid is above the suggested band.' : 'Proposed bid is within the suggested band.' },
    { key: 'max_increase', passed: delta !== null && c.maxIncrease !== null && delta <= c.maxIncrease, source: c.settingSource, reason: c.maxIncrease === null ? 'Maximum increase setting is missing.' : `Maximum increase ${c.maxIncrease * 100}%.` },
    { key: 'max_decrease', passed: delta !== null && c.maxDecrease !== null && -delta <= c.maxDecrease, source: c.settingSource, reason: c.maxDecrease === null ? 'Maximum decrease setting is missing.' : `Maximum decrease ${c.maxDecrease * 100}%.` },
    { key: 'campaign_limits', passed: placementsKnown && bid > 0 && c.bidFloor !== null && c.bidCeiling !== null && c.campaignBudget !== null && c.campaignBudget > 0 && bid >= c.bidFloor && bid <= c.bidCeiling, source: c.settingSource, reason: !placementsKnown ? 'Campaign placement modifiers are not measured.' : c.bidFloor === null || c.bidCeiling === null || c.campaignBudget === null ? 'Campaign bid bounds or budget are missing.' : `Bid bounds ${c.bidFloor}–${c.bidCeiling}; campaign daily budget ${c.campaignBudget}.` },
  ];
}
