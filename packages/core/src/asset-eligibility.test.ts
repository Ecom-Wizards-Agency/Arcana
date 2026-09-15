import { describe, expect, it } from 'vitest';
import { deriveAssetEligibility } from './asset-eligibility.js';
import type { AssetLibraryObservation, AssetModerationObservation } from '@wizard-ads/shared';
const scope = { region: 'EU', amazonProfileId: '1000000001' } as const;
const context = { scope, marketplace: 'DE', program: 'SB_VIDEO' }; const identity = { assetId: 'asset-one', version: 'v1' };
const observedAt = '2026-09-15T10:00:00Z'; const expiresAt = '2026-09-16T10:00:00Z';
const asset: AssetLibraryObservation = { scope, identity, observedAt, assetType: 'video', name: 'Synthetic', processing: 'active',
  specChecks: { approvedPrograms: ['SPONSORED_BRANDS_VIDEO'], failedSpecChecks: [] } };
const moderation: AssetModerationObservation = { context, subject: { kind: 'ad', adId: 'ad-one', adVersion: 'creative-v1' }, assetIdentity: identity,
  stage: 'final', source: 'moderation_v4', status: 'approved', reasons: [], observedAt, contractVersion: 'wp313.v1' };
const input = () => ({ context, identity, now: '2026-09-15T12:00:00Z', asset: { observation: asset, expiresAt }, moderation: [{ observation: moderation, expiresAt }] });
describe('asset eligibility precedence', () => {
  it('requires active metadata, specifications and exact current final moderation', () => {
    expect(deriveAssetEligibility(input())).toMatchObject({ selectable: true, canRun: 'eligible' });
    expect(deriveAssetEligibility({ ...input(), asset: null }).selectable).toBe(false);
    expect(deriveAssetEligibility({ ...input(), moderation: [] })).toMatchObject({ selectable: false, evidenceState: 'partial' });
  });
  it.each(['pending', 'rejected', 'unknown'] as const)('keeps %s ineligible for selection', (status) => {
    expect(deriveAssetEligibility({ ...input(), moderation: [{ observation: { ...moderation, status }, expiresAt }] }).selectable).toBe(false);
  });
  it.each(['scope', 'marketplace', 'program', 'version', 'stage', 'stale'])('refuses %s evidence', (change) => {
    const observation = structuredClone(moderation); let expiry = expiresAt;
    if (change === 'scope') observation.context.scope.amazonProfileId = '1000000002';
    if (change === 'marketplace') observation.context.marketplace = 'US';
    if (change === 'program') observation.context.program = 'SPONSORED_DISPLAY';
    if (change === 'version') observation.assetIdentity!.version = 'v2';
    if (change === 'stage') { observation.stage = 'pre_moderation'; observation.source = 'unified_pre_moderation_v1'; }
    if (change === 'stale') expiry = observedAt;
    expect(deriveAssetEligibility({ ...input(), moderation: [{ observation, expiresAt: expiry }] }).selectable).toBe(false);
  });
  it('refuses invalid evidence expiry', () => {
    expect(deriveAssetEligibility({ ...input(), asset: { observation: asset, expiresAt: 'invalid' } })).toMatchObject({ selectable: false, evidenceState: 'stale' });
  });
  it('retains a newer rejection when older approval arrives later', () => {
    const observation = { ...moderation, status: 'rejected' as const, reasons: ['Prohibited content.'], observedAt: '2026-09-15T11:00:00Z' };
    expect(deriveAssetEligibility({ ...input(), moderation: [{ observation, expiresAt }, ...input().moderation] })).toMatchObject({ status: 'rejected', selectable: false, reasons: ['Prohibited content.'] });
  });
  it('never substitutes processing or specifications for moderation, and refuses equal-time conflict', () => {
    expect(deriveAssetEligibility({ ...input(), moderation: [] }).selectable).toBe(false);
    expect(deriveAssetEligibility({ ...input(), asset: { observation: { ...asset, processing: 'processing' }, expiresAt } }).selectable).toBe(false);
    expect(deriveAssetEligibility({ ...input(), asset: { observation: { ...asset, specChecks: { approvedPrograms: null, failedSpecChecks: null } }, expiresAt } }).selectable).toBe(false);
    expect(deriveAssetEligibility({ ...input(), moderation: [...input().moderation, { observation: { ...moderation, status: 'rejected' }, expiresAt }] })).toMatchObject({ selectable: false, evidenceState: 'partial' });
  });
});
