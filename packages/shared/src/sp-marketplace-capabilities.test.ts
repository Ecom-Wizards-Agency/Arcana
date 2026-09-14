import { expect, it } from 'vitest';
import { SP_MARKETPLACE_MONEY_RULES, SpMarketplaceBidCapability, spMarketplaceBidCapability } from './sp-marketplace-capabilities.js';

it('resolves every pinned marketplace with exact bid bounds and currency precision', () => {
  const entries = Object.entries(SP_MARKETPLACE_MONEY_RULES);
  expect(entries).toHaveLength(23);
  for (const [marketplaceId, rule] of entries) {
    const scope = { marketplaceId, region: rule.region, currencyCode: rule.currencyCode };
    const snapshot = spMarketplaceBidCapability(scope);
    expect(snapshot).toMatchObject({ ...scope, bidMin: Number(rule.bidMin), bidMax: Number(rule.bidMax), decimalPlaces: rule.scale });
    expect(SpMarketplaceBidCapability.safeParse(snapshot).success).toBe(true);
    expect(Number(rule.bidMin)).toBeGreaterThan(0);
    expect(Number(rule.bidMax)).toBeGreaterThan(Number(rule.bidMin));
    expect(Number(Number(rule.bidMin).toFixed(rule.scale))).toBe(Number(rule.bidMin));
    expect(Number(Number(rule.bidMax).toFixed(rule.scale))).toBe(Number(rule.bidMax));
  }
});

it('refuses missing or mismatched marketplace identity without choosing a currency default', () => {
  const [marketplaceId, rule] = Object.entries(SP_MARKETPLACE_MONEY_RULES)[0]!;
  expect(spMarketplaceBidCapability(undefined)).toBeNull();
  expect(spMarketplaceBidCapability({ marketplaceId: 'unknown', region: rule.region, currencyCode: rule.currencyCode })).toBeNull();
  expect(spMarketplaceBidCapability({ marketplaceId, region: rule.region, currencyCode: 'XXX' })).toBeNull();
  expect(spMarketplaceBidCapability({ marketplaceId, region: rule.region === 'EU' ? 'NA' : 'EU', currencyCode: rule.currencyCode })).toBeNull();
});
