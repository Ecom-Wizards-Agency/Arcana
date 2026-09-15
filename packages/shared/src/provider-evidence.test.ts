import { expect, it } from 'vitest';
import { ProviderCollectionConfig, ProviderEvidenceCounts, ProviderEstimate } from './provider-evidence.js';

it('keeps unknown estimates null and labels them as provider estimates', () => {
  const estimate = ProviderEstimate.parse({ label: 'Amazon estimate', metric: 'clicks', value: null, low: null, high: null, units: null, currency: null, horizon: null, attribution: null });
  expect(estimate.value).toBeNull();
  expect(ProviderEstimate.safeParse({ ...estimate, label: 'Observed clicks' }).success).toBe(false);
});
it('reconciles refusals, duplicate inputs and independent destination readback', () => {
  const counts = { source: 5, parsed: 4, refused: 1, duplicates: 1, conflicts: 1, canonical: 3, written: 2, existing: 1, readback: 3 };
  expect(ProviderEvidenceCounts.parse(counts)).toEqual(counts);
  for (const key of ['source', 'parsed', 'canonical', 'readback', 'written'] as const) expect(ProviderEvidenceCounts.safeParse({ ...counts, [key]: counts[key] + 1 }).success).toBe(false);
});
it('defaults source configuration to disabled and manual', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const config = ProviderCollectionConfig.parse({ id, scope: { orgId: id, profileId: id, marketplaceId: 'synthetic-market', amazonProfileId: 'synthetic-profile' }, family: 'tactical', operation: 'tactical.list', request: {}, maxPages: 2, maxRows: 100 });
  expect(config.enabled).toBe(false); expect(config.cadence).toBe('manual');
  expect(ProviderCollectionConfig.safeParse({ ...config, apply: true }).success).toBe(false);
});
