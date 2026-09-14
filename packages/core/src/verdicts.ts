import type { PerformanceVerdict, VerdictEvidence, VerdictThresholds } from '@wizard-ads/shared';

/** Settings are supplied by profile/group resolution; this classifier has no defaults. */
export function classifyPerformanceVerdict(input: VerdictEvidence, thresholds: VerdictThresholds | null): PerformanceVerdict {
  const insufficient = (reason: string): PerformanceVerdict => ({ diagnosis: 'Insufficient evidence', reason });
  if (!thresholds || Object.values(thresholds).some((value) => value === null || !Number.isFinite(value))) {
    return insufficient('no threshold configured');
  }
  const { ownedRank, rankGap, targetAcos } = thresholds;
  if (ownedRank === null || rankGap === null || targetAcos === null) return insufficient('no threshold configured');
  if (input.spend === null) return insufficient('advertising spend not measured');
  if (input.organicRank !== null && input.spend === 0) {
    return { diagnosis: 'Ranked, unfunded', reason: 'Organic rank is measured and advertising spend is measured at zero.' };
  }
  if (input.organicRank !== null && input.organicRank <= ownedRank && input.spend > 0) {
    return { diagnosis: 'Paying for rank we own', reason: 'Organic rank is within the configured ownership band and advertising spend is positive.' };
  }
  if (input.organicRank !== null && input.organicRank >= rankGap && input.spend > 0) return { diagnosis: 'Rank gap', reason: 'Organic rank is outside the configured rank band.' };
  if (input.acos !== null && input.acos <= targetAcos) return { diagnosis: 'Efficient', reason: 'Measured ACOS is at or below the resolved target.' };
  return insufficient('no configured diagnosis matches the measured evidence');
}
