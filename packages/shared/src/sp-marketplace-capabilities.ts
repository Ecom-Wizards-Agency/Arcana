import { z } from 'zod';
import { CurrencyCode, Region } from './primitives.js';

export type SpMarketplaceMoneyRule = Readonly<{
  region: 'NA' | 'EU' | 'FE';
  currencyCode: string;
  scale: number;
  bidMin: string;
  bidMax: string;
  budgetMin: string;
  budgetMax: string;
}>;

/**
 * Active marketplace identities plus the SP rows in Amazon's limits table,
 * captured 2026-08-31. China is not present because the current active-store
 * table has no China identity and the limits table has no current SP bid row.
 * Source: https://advertising.amazon.com/API/docs/en-us/concepts/limits
 * Moved intact from the provider compiler; keep bid and budget rules in one table.
 */
export const SP_MARKETPLACE_MONEY_RULES: Readonly<Record<string, SpMarketplaceMoneyRule>> = Object.freeze({
  A1AM78C64UM0Y8: rule('NA', 'MXN', 2, '0.1', '20000', '1', '21000000'),
  A1F83G8C2ARO7P: rule('EU', 'GBP', 2, '0.02', '1000', '1', '1000000'),
  A1PA6795UKMFR9: rule('EU', 'EUR', 2, '0.02', '1000', '1', '1000000'),
  A2EUQ1WTGCTBG2: rule('NA', 'CAD', 2, '0.02', '1000', '1', '1000000'),
  A39IBJ37TRP1C6: rule('FE', 'AUD', 2, '0.02', '1410', '1.4', '1500000'),
  ATVPDKIKX0DER: rule('NA', 'USD', 2, '0.02', '1000', '1', '1000000'),
  A13V1IB3VIYZZH: rule('EU', 'EUR', 2, '0.02', '1000', '1', '1000000'),
  A1RKKUPIHCS9HS: rule('EU', 'EUR', 2, '0.02', '1000', '1', '1000000'),
  APJ6JRA9NG5V4: rule('EU', 'EUR', 2, '0.02', '1000', '1', '1000000'),
  A1805IZSGTT6HS: rule('EU', 'EUR', 2, '0.02', '1000', '1', '1000000'),
  A1VC38T7YXB528: rule('FE', 'JPY', 0, '2', '100000', '100', '21000000'),
  A2VIGQ35RCS4UG: rule('EU', 'AED', 2, '0.24', '184', '4', '3700000'),
  A2Q3Y263D00KWC: rule('NA', 'BRL', 2, '0.07', '3700', '1.32', '5300000'),
  A19VAU5U5O7RUS: rule('FE', 'SGD', 2, '0.02', '1100', '1.39', '1300000'),
  A2NODRKZP88ZB9: rule('EU', 'SEK', 2, '0.18', '9300', '9', '9300000'),
  A21TJRUUN4KGV: rule('EU', 'INR', 2, '1', '5000', '50', '21000000'),
  A1C3SOZRARQ6R3: rule('EU', 'PLN', 2, '0.04', '2000', '2', '2000000'),
  A33AVAJ2PDY3EV: rule('EU', 'TRY', 2, '0.05', '2500', '2', '2500000'),
  ARBP9OOSHTCHU: rule('EU', 'EGP', 2, '0.15', '5.5', '7', '7400000'),
  A17E79C6D8DWNP: rule('EU', 'SAR', 2, '0.1', '3670', '4', '3700000'),
  AMEN7PMS3EDWL: rule('EU', 'EUR', 2, '0.02', '1000', '1', '1000000'),
  AE08WJ6YKNBMC: rule('EU', 'ZAR', 2, '1', '7000', '20', '7000000'),
  A28R8C7NBKEWEA: rule('EU', 'EUR', 2, '0.02', '1000', '1', '1000000'),
});

function rule(
  region: SpMarketplaceMoneyRule['region'],
  currencyCode: string,
  scale: number,
  bidMin: string,
  bidMax: string,
  budgetMin: string,
  budgetMax: string,
): SpMarketplaceMoneyRule {
  return Object.freeze({ region, currencyCode, scale, bidMin, bidMax, budgetMin, budgetMax });
}

export const SpMarketplaceScope = z.object({ marketplaceId: z.string().min(1), region: Region, currencyCode: CurrencyCode });
export type SpMarketplaceScope = z.infer<typeof SpMarketplaceScope>;
export const SpMarketplaceBidCapability = SpMarketplaceScope.extend({ bidMin: z.number().positive(), bidMax: z.number().positive(), decimalPlaces: z.number().int().min(0).max(6), verifiedOn: z.iso.date() });
export type SpMarketplaceBidCapability = z.infer<typeof SpMarketplaceBidCapability>;

/** Unknown identities or inconsistent profile currency/region fail closed. */
export function spMarketplaceBidCapability(scope: SpMarketplaceScope | undefined): SpMarketplaceBidCapability | null {
  if (scope === undefined) return null;
  const rule = SP_MARKETPLACE_MONEY_RULES[scope.marketplaceId];
  if (rule === undefined || rule.region !== scope.region || rule.currencyCode !== scope.currencyCode) return null;
  return { ...scope, bidMin: Number(rule.bidMin), bidMax: Number(rule.bidMax), decimalPlaces: rule.scale, verifiedOn: '2026-08-31' };
}
