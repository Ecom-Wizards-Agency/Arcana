import { describe, expect, it } from 'vitest';
import { ProviderGraphAssociation, ProviderGraphCounts, ProviderGraphObservation,
  providerGraphIdentityKey } from './provider-graph.js';

const scope = { orgId: '00000000-0000-4000-8000-000000000001',
  profileId: '00000000-0000-4000-8000-000000000002', amazonProfileId: 'synthetic', region: 'NA' as const };
const identity = { adProduct: 'SB' as const, kind: 'ad' as const, providerId: 'ad-one', version: null };
describe('provider graph contracts', () => {
  it('preserves tenant, product and version in identity', () => {
    const key = providerGraphIdentityKey(scope, identity);
    expect(providerGraphIdentityKey(scope, { ...identity, version: 'version-one' })).not.toBe(key);
    expect(providerGraphIdentityKey(scope, { ...identity, adProduct: 'SD' })).not.toBe(key);
    expect(providerGraphIdentityKey({ ...scope, amazonProfileId: 'other' }, identity)).not.toBe(key);
  });
  it('refuses uncounted persistence and missing independent readback', () => {
    const counts = { source: 4, parsed: 3, refused: 1, duplicates: 1, canonical: 2,
      stored: 1, existing: 1, verified: 2 };
    expect(ProviderGraphCounts.safeParse(counts).success).toBe(true);
    expect(ProviderGraphCounts.safeParse({ ...counts, verified: 1 }).success).toBe(false);
    expect(ProviderGraphCounts.safeParse({ ...counts, source: 5 }).success).toBe(false);
  });
  it('refuses cross-product edges and durable raw fields', () => {
    const common = { sourceEventAt: '2026-09-01T00:00:00Z', revision: null,
      payloadFingerprint: 'a'.repeat(64), operation: 'upsert' };
    expect(ProviderGraphAssociation.safeParse({ ...common, scope, from: identity,
      to: { ...identity, adProduct: 'SD' }, relation: 'parent' }).success).toBe(false);
    expect(ProviderGraphObservation.safeParse({ ...common, scope, identity,
      observedAt: common.sourceEventAt, source: 'product_api', contractVersion: 'v4',
      state: 'unknown', raw: { url: 'transient' } }).success).toBe(false);
  });
});
