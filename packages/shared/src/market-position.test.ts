import { expect, it } from 'vitest';
import { MarketPositionSettingsInput, MarketRankPoint } from './market-position.js';

it('accepts percentage points including both endpoints and refuses invalid preferences', () => {
  const profileId = '00000000-0000-4000-8000-000000000001';
  for (const thresholdPercent of [0, 15, 100]) expect(MarketPositionSettingsInput.parse({ profileId, thresholdPercent }).thresholdPercent).toBe(thresholdPercent);
  for (const thresholdPercent of [-1, 101, NaN, Infinity, null, '15']) expect(MarketPositionSettingsInput.safeParse({ profileId, thresholdPercent }).success).toBe(false);
  expect(MarketPositionSettingsInput.safeParse({ profileId, thresholdPercent: 15, orgId: profileId }).success).toBe(false);
});
it('preserves missing ranks and rejects zero and impossible dates', () => {
  expect(MarketRankPoint.parse({ date: '2026-06-01', bsr: null }).bsr).toBeNull();
  expect(MarketRankPoint.safeParse({ date: '2026-06-01', bsr: 0 }).success).toBe(false);
  expect(MarketRankPoint.safeParse({ date: '2026-02-30', bsr: 1 }).success).toBe(false);
});
it('carries optional observed evidence without inferring a badge or a subcategory', () => {
  const base = { date: '2026-06-01', bsr: 1 };
  expect(MarketRankPoint.parse(base).bestSellerBadge).toBeUndefined();
  expect(MarketRankPoint.parse({ ...base, bestSellerBadge: false }).bestSellerBadge).toBe(false);
  expect(MarketRankPoint.parse({ ...base, bestSellerBadge: null }).bestSellerBadge).toBeNull();
  expect(MarketRankPoint.safeParse({ ...base, subcategory: { rank: 0, name: 'Synthetic category' } }).success).toBe(false);
});
