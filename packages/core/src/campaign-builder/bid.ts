import type { CampaignBuilderBidBounds, CampaignBuilderBidEvidence, CampaignBuilderKeyword } from '@wizard-ads/shared';

export function calculateCampaignStartingBid(input: {
  basis: CampaignBuilderKeyword['basis']; manualBid: number | null;
  evidence: CampaignBuilderBidEvidence | null; topOfSearch: number; audienceAdjustment: number;
  bounds: CampaignBuilderBidBounds;
}) {
  const { evidence, bounds } = input;
  const cpc = evidence !== null && evidence.clicks > 0 ? evidence.spend / evidence.clicks : null;
  const rounding = 0.5 * 10 ** -bounds.decimalPlaces;
  const reconciled = cpc === null || evidence?.reportedCpc == null ? null
    : Math.abs(cpc - evidence.reportedCpc) <= rounding + Number.EPSILON;
  const placementMultiplier = 1 + input.topOfSearch / 100;
  const audienceMultiplier = 1 + input.audienceAdjustment / 100;
  const rawBase = input.basis === 'manual' ? input.manualBid
    : input.basis === 'keyword_cpc' && reconciled === true ? cpc! / placementMultiplier : null;
  const validBounds = bounds.floor !== null && bounds.ceiling !== null && bounds.floor <= bounds.ceiling;
  const suggested = rawBase === null || !validBounds ? null
    : Math.min(bounds.ceiling!, Math.max(bounds.floor!, rawBase));
  const base = suggested === null ? null : Math.min(bounds.ceiling!, Math.max(bounds.floor!,
    Math.round((suggested + Number.EPSILON) * 10 ** bounds.decimalPlaces) / 10 ** bounds.decimalPlaces));
  // An operator's entered bid is reviewed exactly; the suggestion's clamp must not hide an invalid input.
  const reviewedBase = input.manualBid ?? base;
  const exposure = reviewedBase === null ? null : reviewedBase * placementMultiplier * audienceMultiplier;
  const inRange = reviewedBase !== null && validBounds && reviewedBase >= bounds.floor!
    && reviewedBase <= bounds.ceiling! && Number.isFinite(reviewedBase)
    && Math.abs(reviewedBase * 10 ** bounds.decimalPlaces - Math.round(reviewedBase * 10 ** bounds.decimalPlaces)) < 1e-7;
  const exceeded = exposure !== null && bounds.exposureCeiling !== null && exposure > bounds.exposureCeiling + Number.EPSILON;
  return { cpc, reconciled, placementMultiplier, audienceMultiplier, rawBase, base, exposure,
    inRange, exceeded, usable: inRange && !exceeded && bounds.exposureCeiling !== null
      && (input.basis === 'manual' || input.basis === 'keyword_cpc' && reconciled === true) };
}

/** Call only when saving. Read the stored sentence thereafter, even if strategy changes. */
export function campaignBidRationale(input: {
  keyword: string; basis: CampaignBuilderKeyword['basis']; bid: number; currency: string;
  topOfSearch: number; audienceAdjustment: number; evidence: CampaignBuilderBidEvidence | null;
}): string {
  const exposure = input.bid * (1 + input.topOfSearch / 100) * (1 + input.audienceAdjustment / 100);
  const basis = input.basis === 'manual' ? 'an operator-entered bid'
    : input.basis === 'keyword_cpc' ? `keyword CPC from ${input.evidence?.start ?? 'an unavailable period'} to ${input.evidence?.end ?? 'an unavailable period'}`
      : 'SQP value';
  return `Starting bid ${input.currency} ${input.bid} for “${input.keyword}” uses ${basis}. Top-of-search adjustment ${input.topOfSearch}% and audience adjustment ${input.audienceAdjustment}% compound to ${input.currency} ${Number(exposure.toFixed(6))} exposure.`;
}
