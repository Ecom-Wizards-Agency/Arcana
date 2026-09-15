import { describe, expect, it } from 'vitest';
import { CollectorReceipt, ListingSnapshot, StoredCollectorExport, CollectorProfile, EffectiveBidHistory, ListingChangeInput, CollectorRefusalCode } from './own-collectors.js';
const scope = { orgId: '00000000-0000-4000-8000-000000000001', profileId: '00000000-0000-4000-8000-000000000002', marketplace: 'US' };
const provenance = { source: 'synthetic', sourceIdentity: 'one', observedAt: '2026-09-01T00:00:00Z', collectedAt: '2026-09-02T00:00:00Z' };
describe('own collector contracts', () => {
  it('keeps unknown fields absent and rejects duplicate fields', () => {
    const snapshot = { scope, asin: 'B000000001', sourceIdentity: 'one', collectedAt: provenance.collectedAt, fields: [{ field: 'price', value: 2, provenance }] };
    expect(ListingSnapshot.parse(snapshot).fields.map((f) => f.field)).toEqual(['price']);
    expect(ListingSnapshot.safeParse({ ...snapshot, fields: [...snapshot.fields, ...snapshot.fields] }).success).toBe(false);
  });
  it('rejects dropped outputs and fabricated measured coverage', () => {
    const receipt = { counts: { sourceRows: 1, parsedRows: 1, refusedRows: 0, loadedRows: 1, verifiedLoadedRows: 1 }, inserted: 1, alreadyPresent: 0, outputIdentities: ['one'], observedAt: provenance.observedAt, state: 'measured' };
    expect(CollectorReceipt.safeParse(receipt).success).toBe(true);
    expect(CollectorReceipt.safeParse({ ...receipt, outputIdentities: [] }).success).toBe(false);
    expect(CollectorReceipt.safeParse({ ...receipt, observedAt: null }).success).toBe(false);
    expect(CollectorReceipt.safeParse({ ...receipt, counts: { ...receipt.counts, verifiedLoadedRows: 0 } }).success).toBe(false);
  });
  it.each(['../escape', '/absolute', 'a/../../escape', 'a//b', './x'])('refuses unsafe export key %s', (objectKey) => {
    expect(StoredCollectorExport.safeParse({ id: scope.orgId, scope, family: 'prompts', enabled: true, objectKey }).success).toBe(false);
  });
});

it('validates complete reader envelopes and derivation inputs', () => {
  expect(CollectorProfile.parse({ scope, timezone: 'America/Los_Angeles', enabled: true }).enabled).toBe(true);
  expect(CollectorProfile.safeParse({ scope, timezone: 'Invalid/Timezone', enabled: true }).success).toBe(false);
  expect(CollectorProfile.safeParse({ scope, timezone: 'UTC', enabled: 'true' }).success).toBe(false);
  expect(EffectiveBidHistory.safeParse({ timezone: 'Invalid/Timezone', observations: [] }).success).toBe(false);
  const current = { field: 'price', value: 12, provenance };
  expect(ListingChangeInput.safeParse({ id: 'one', scope, asin: 'B000000001', previous: null, current, timezone: 'UTC', hasEarlierObservation: false }).success).toBe(true);
  expect(ListingChangeInput.safeParse({ id: 'one', scope, asin: 'B000000001', previous: { ...current, field: 'rating' }, current, timezone: 'UTC', hasEarlierObservation: false }).success).toBe(false);
  expect(CollectorRefusalCode.options).toEqual(['malformed_content', 'scope_mismatch', 'unauthorized_reference', 'invalid_file_bounds']);
});
