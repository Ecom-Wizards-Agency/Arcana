import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CatalogueCollectionCounts, EvidenceField, ProductMetadataSnapshot } from './ads-catalogue.js';

const scope = { orgId: '10000000-0000-4000-8000-000000000001', profileId: '10000000-0000-4000-8000-000000000002', marketplaceId: 'market-one' };
const provenance = { family: 'product_metadata' as const, contractVersion: 'v1', providerObservedAt: null, acquiredAt: '2026-09-15T01:00:00.000Z', retrievedAt: '2026-09-15T01:00:01.000Z' };

describe('catalogue evidence contracts', () => {
  it('preserves returned zero separately from absent inventory', () => {
    const parsed = ProductMetadataSnapshot.parse({ scope, asin: 'ASIN000001', sku: null, adProduct: 'SP', provenance,
      title: { state: 'absent', reason: null }, imageUrl: { state: 'absent', reason: null }, category: { state: 'absent', reason: null },
      variationAsins: { state: 'returned', value: [], sourceField: 'variationList' },
      price: { state: 'returned', value: { amount: 0, currency: 'USD' }, sourceField: 'priceToPay' },
      basisPrice: { state: 'absent', reason: null }, availability: { state: 'absent', reason: null },
      inventoryQuantity: { state: 'absent', reason: 'provider does not return quantity' },
      bestSellerRank: { state: 'returned', value: 0, sourceField: 'bestSellerRank' } });
    expect(parsed.price).toMatchObject({ state: 'returned', value: { amount: 0 } });
    expect(parsed.inventoryQuantity.state).toBe('absent');
  });

  it('rejects unreconciled collection counts', () => {
    expect(() => CatalogueCollectionCounts.parse({ requestedMembers: 2, pages: 1, sourceRows: 2, parsedRows: 1,
      refusedRows: 0, duplicates: 0, canonicalRows: 1, writtenRows: 1, existingRows: 0, verifiedRows: 1 })).toThrow();
  });

  it('makes field state explicit', () => {
    const field = EvidenceField(z.number());
    expect(field.parse({ state: 'returned', value: 0, sourceField: 'count' })).toMatchObject({ value: 0 });
  });
});
