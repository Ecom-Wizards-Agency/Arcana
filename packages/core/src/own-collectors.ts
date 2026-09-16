import { ListingChangeInput } from '@wizard-ads/shared';
import type { EffectiveBidObservation, EffectiveBidProjection, ListingChange } from '@wizard-ads/shared';
import { creativeChangeCertainty } from './creative/certainty.js';

export function collectorDate(at: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
}
/** Placements are alternatives. Cohort composition is not established by the mirror schema. */
export function projectEffectiveBid(observation: EffectiveBidObservation, timezone: string): EffectiveBidProjection {
  const date = collectorDate(observation.observedAt, timezone);
  const result: EffectiveBidProjection = { observation, date, observedBid: observation.bid && collectorDate(observation.bid.provenance.observedAt, timezone) === date ? observation.bid.value : null, scenarios: [], configuredExposure: null, composition: 'incomplete' };
  const { bid, bidding, placementProvenance, audienceProvenance } = observation;
  if (!bid || !bidding || !placementProvenance || !audienceProvenance) return result;
  if ([bid.provenance, placementProvenance, audienceProvenance].some((p) => collectorDate(p.observedAt, timezone) !== date)) {
    return { ...result, composition: 'different_observation_days' };
  }
  if (bidding.placements.amazonBusiness === null || !['manual', 'legacy_for_sales'].includes(bidding.strategy)) return result;
  if (bidding.shopperCohorts.length || bidding.placements.amazonBusiness !== 0) return { ...result, composition: 'unsupported_audience' };
  const placements = ['topOfSearch', 'productPages', 'restOfSearch'] as const;
  if (placements.some((p) => bidding.placements[p] === null)) return result;
  const scenarios = placements.map((placement) => ({ placement, percentage: bidding.placements[placement]!,
    configuredExposure: bid.value * (1 + bidding.placements[placement]! / 100) }));
  return { ...result, scenarios, configuredExposure: Math.max(...scenarios.map((s) => s.configuredExposure)), composition: 'placement_only' };
}

/** Projection contains only observed dates, with source identity as the final tie breaker. */
export function dailyEffectiveBids(rows: readonly EffectiveBidObservation[], timezone: string): EffectiveBidProjection[] {
  const days = new Map<string, EffectiveBidProjection>();
  for (const row of [...rows].sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.sourceIdentity.localeCompare(b.sourceIdentity))) {
    const projected = projectEffectiveBid(row, timezone);
    const key = JSON.stringify([row.scope, row.targetKind, row.campaignId, row.adGroupId, row.targetId, projected.date]);
    days.set(key, projected);
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date) || a.observation.sourceIdentity.localeCompare(b.observation.sourceIdentity));
}

export function listingFieldChange(raw: ListingChangeInput): ListingChange | null {
  const input = ListingChangeInput.parse(raw);
  const { previous, current } = input;
  if (previous && previous.field !== current.field) throw new Error('Listing boundary fields differ');
  if (previous && JSON.stringify(previous.value) === JSON.stringify(current.value)) return null;
  const sameSource = previous?.provenance.source === current.provenance.source;
  const certainty = creativeChangeCertainty({ previous: previous?.provenance.observedAt ?? null,
    observedAt: current.provenance.observedAt, firstObservation: previous === null && !input.hasEarlierObservation,
    timezone: input.timezone, currentObserved: sameSource });
  return { id: input.id, scope: input.scope, asin: input.asin, previous, current, certainty };
}
