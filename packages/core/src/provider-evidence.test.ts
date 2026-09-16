import { expect, it } from 'vitest';
import { ProviderRecommendation } from '@wizard-ads/shared';
import { compareProviderEvidence, providerEvidenceAvailability, providerEvidenceSnapshot } from './provider-evidence.js';
const at = '2026-06-01T00:00:00.000Z'; const id = '00000000-0000-4000-8000-000000000091';
const recommendation = () => ProviderRecommendation.parse({ family: 'tactical', namespace: 'synthetic', providerId: 'synthetic', identityMethod: 'provider', version: 'a'.repeat(64), apiVersion: 'synthetic-v1', contractHash: 'b'.repeat(64), transport: 'http', scope: { orgId: id, profileId: id, marketplaceId: 'synthetic-market', amazonProfileId: 'synthetic-profile' }, entity: { adProduct: 'SP', entityType: 'campaign', entityId: 'synthetic-campaign', campaignId: 'synthetic-campaign', adGroupId: null, mapping: 'mapped' }, kind: 'CAMPAIGN_BUDGET', action: 'budget', current: { value: 5, units: 'daily-budget', currency: 'USD' }, proposed: { value: 6, units: 'daily-budget', currency: 'USD' }, estimates: [], objective: 'sales', horizon: 'one-day', attribution: '14-day click', eligibility: 'unknown', generatedAt: at, expiresAt: null, retrievedAt: at, observedAt: at, payload: {} });
it('compares only matching observed baselines and preserves both sources', () => {
  const amazon = recommendation(); const arcana = recommendation(); const before = structuredClone(amazon);
  expect(compareProviderEvidence(amazon, arcana, at).status).toBe('agrees');
  arcana.proposed.value = 7; expect(compareProviderEvidence(amazon, arcana, at).status).toBe('disagrees');
  expect(amazon).toEqual(before);
  expect(compareProviderEvidence(amazon, null, at).status).toBe('not-comparable');
});
it.each(['units', 'currency', 'horizon', 'baseline', 'action', 'expiry', 'missing'] as const)('refuses incompatible %s evidence', (kind) => {
  const amazon = recommendation(); const arcana = recommendation();
  if (kind === 'units') arcana.proposed.units = 'percent';
  if (kind === 'currency') arcana.proposed.currency = 'EUR';
  if (kind === 'horizon') arcana.horizon = 'one-week';
  if (kind === 'baseline') arcana.current.value = 4;
  if (kind === 'action') amazon.action = 'unknown';
  if (kind === 'expiry') amazon.expiresAt = at;
  if (kind === 'missing') amazon.current.value = null;
  expect(compareProviderEvidence(amazon, arcana, at).status).toBe('not-comparable');
});
it('distinguishes unmeasured, empty measured, partial, stale and expired availability', () => {
  expect(providerEvidenceAvailability({ status: 'complete', observedAt: null, expiresAt: null }, at, 1000)).toBe('not-measured');
  expect(providerEvidenceAvailability({ status: 'complete', observedAt: at, expiresAt: null }, at, 1000)).toBe('measured');
  expect(providerEvidenceAvailability({ status: 'partial', observedAt: at, expiresAt: null }, at, 1000)).toBe('partial');
  expect(providerEvidenceAvailability({ status: 'complete', observedAt: at, expiresAt: null }, '2026-06-02T00:00:00Z', 1000)).toBe('stale');
  expect(providerEvidenceAvailability({ status: 'complete', observedAt: at, expiresAt: at }, at, 1000)).toBe('expired');
});

it('never treats missing currency as monetary agreement', () => {
  const a = recommendation(); const b = recommendation(); a.proposed.currency = null; b.proposed.currency = null;
  expect(compareProviderEvidence(a,b,at).status).toBe('not-comparable');
});
it('aggregates latest configured scopes without hiding partial retrieval or inferring expiry from truncated rows', () => {
  const counts = { source: 1, parsed: 1, refused: 0, duplicates: 0, conflicts: 0, canonical: 1, written: 1, existing: 0, readback: 1 };
  const common = { family: 'tactical' as const, observedAt: at, startedAt: at, counts, expiresAt: '2026-06-03T00:00:00.000Z' };
  const row = { ...recommendation(), expiresAt: at };
  const snapshot = providerEvidenceSnapshot({ rows: [row], totalCount: 2, runs: [{ ...common, configId: id, status: 'partial' }, { ...common, configId: '00000000-0000-4000-8000-000000000092', status: 'complete' }] }, 'recommendations', at);
  expect(snapshot.families.find((f) => f.family === 'tactical')).toMatchObject({ availability: 'partial', counts: { source: 2, canonical: 2, readback: 2 } });
  expect(snapshot.rows[0]?.availability).toBe('expired'); expect(snapshot.truncated).toBe(true);
});

it.each(['both-unknown', 'provider-unknown', 'arcana-unknown', 'different-window', 'inapplicable-vs-window'] as const)('refuses %s attribution without inventing agreement', (kind) => {
  const amazon = recommendation(); const arcana = recommendation();
  if (kind === 'both-unknown' || kind === 'provider-unknown') amazon.attribution = null;
  if (kind === 'both-unknown' || kind === 'arcana-unknown') arcana.attribution = null;
  if (kind === 'different-window') arcana.attribution = '7-day click';
  if (kind === 'inapplicable-vs-window') amazon.attribution = { status: 'not-applicable' };
  expect(compareProviderEvidence(amazon, arcana, at).status).toBe('not-comparable');
});
it('compares explicitly inapplicable attribution independently of object identity', () => {
  const amazon = recommendation(); const arcana = recommendation();
  amazon.attribution = { status: 'not-applicable' }; arcana.attribution = { status: 'not-applicable' };
  expect(compareProviderEvidence(amazon, arcana, at).status).toBe('agrees');
  arcana.proposed.value = 7;
  expect(compareProviderEvidence(amazon, arcana, at).status).toBe('disagrees');
});
