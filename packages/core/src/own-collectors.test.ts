import { expect, it } from 'vitest';
import type { EffectiveBidObservation, ListingFieldObservation } from '@wizard-ads/shared';
import { dailyEffectiveBids, listingFieldChange, projectEffectiveBid } from './own-collectors.js';
const scope = { orgId: '00000000-0000-4000-8000-000000000001', profileId: '00000000-0000-4000-8000-000000000002', marketplace: 'US' };
const at = '2026-09-01T12:00:00Z';
const provenance = { source: 'synthetic', sourceIdentity: 'one', observedAt: at, collectedAt: at };
const bid: EffectiveBidObservation = { scope, sourceIdentity: 'one', campaignId: 'c', adGroupId: 'g', targetId: 'k', targetKind: 'keyword', observedAt: at, collectedAt: at,
  bid: { value: 2, provenance }, bidOrigin: 'explicit', bidding: { strategy: 'manual', placements: { topOfSearch: 100, productPages: 50, restOfSearch: 0, amazonBusiness: 0 }, shopperCohorts: [], offAmazonBudgetControlStrategy: null }, placementProvenance: provenance, audienceProvenance: provenance };
it('keeps three alternative placements and known zeros', () => {
  const value = projectEffectiveBid(bid, 'UTC');
  expect(value.scenarios.map((s) => s.configuredExposure)).toEqual([4, 3, 2]);
  expect(value.configuredExposure).toBe(4);
  const zero = structuredClone(bid); zero.bidding!.placements = { topOfSearch: 0, productPages: 0, restOfSearch: 0, amazonBusiness: 0 };
  expect(projectEffectiveBid(zero, 'UTC').configuredExposure).toBe(2);
});
it('retains incomplete and unsupported audience evidence without deriving exposure', () => {
  expect(projectEffectiveBid({ ...bid, audienceProvenance: null }, 'UTC').configuredExposure).toBeNull();
  const businessUnknown = structuredClone(bid); businessUnknown.bidding!.placements.amazonBusiness = null;
  expect(projectEffectiveBid(businessUnknown, 'UTC').configuredExposure).toBeNull();
  const cohort = structuredClone(bid); cohort.bidding!.shopperCohorts = [{ shopperCohortType: 'synthetic', percentage: 20, audienceSegments: [] }];
  expect(projectEffectiveBid(cohort, 'UTC').composition).toBe('unsupported_audience');
  expect(projectEffectiveBid({ ...bid, audienceProvenance: { ...provenance, observedAt: '2026-08-30T12:00:00Z' } }, 'UTC').composition).toBe('different_observation_days');
});
it('replay does not invent days and separates target kinds', () => {
  const later = { ...bid, observedAt: '2026-09-03T12:00:00Z', collectedAt: '2026-09-03T12:00:00Z', sourceIdentity: 'three' };
  const rows = dailyEffectiveBids([bid, { ...bid, collectedAt: '2026-09-10T00:00:00Z' }, later, { ...bid, targetKind: 'target', bidOrigin: 'inherited' }], 'UTC');
  expect(rows.map((r) => [r.date, r.observation.targetKind])).toEqual([['2026-09-01', 'keyword'], ['2026-09-01', 'target'], ['2026-09-03', 'keyword']]);
});
const field: ListingFieldObservation = { field: 'price', value: 2, provenance };
it('uses actual boundaries for first/exact/window and source switches', () => {
  const run = (previous: ListingFieldObservation | null, day: string, source = 'synthetic', hasEarlierObservation = false) => listingFieldChange({ id: 'x', scope, asin: 'B000000001', previous,
    current: { ...field, value: 3, provenance: { ...provenance, observedAt: `2026-09-${day}T12:00:00Z`, collectedAt: `2026-09-${day}T12:00:00Z`, source } }, timezone: 'UTC', hasEarlierObservation });
  expect(run(null, '02')?.certainty.kind).toBe('first');
  expect(run(field, '02')?.certainty.kind).toBe('exact');
  expect(run(field, '05')?.certainty).toMatchObject({ kind: 'window', widthDays: 4 });
  expect(run(field, '02', 'other')?.certainty.kind).toBe('window');
  expect(run(null, '02', 'synthetic', true)?.certainty).toMatchObject({ kind: 'window', from: null });
});
it('does not project a stale bid onto a newly observed modifier day', () => {
  const later = projectEffectiveBid({ ...bid, observedAt: '2026-09-05T12:00:00Z', collectedAt: '2026-09-05T12:00:00Z',
    placementProvenance: { ...provenance, observedAt: '2026-09-05T12:00:00Z', collectedAt: '2026-09-05T12:00:00Z' } }, 'UTC');
  expect(later.observedBid).toBeNull(); expect(later.configuredExposure).toBeNull();
});
