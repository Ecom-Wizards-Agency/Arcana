import { describe, expect, it } from 'vitest';
import { AssetEligibilityEvidence, AssetModerationObservation } from './asset-evidence.js';
import { AssetLibraryBatchStatus, AssetLibraryUploadManifest } from './asset-library.js';

const context = { scope: { region: 'EU', amazonProfileId: '1000000001' }, marketplace: 'DE', program: 'SB_VIDEO' };
const identity = { assetId: 'synthetic-asset', version: 'asset-v1' };
const observation = { context, subject: { kind: 'ad', adId: 'synthetic-ad', adVersion: 'creative-v2' },
  assetIdentity: null, stage: 'final', source: 'moderation_v4', status: 'approved', reasons: [],
  observedAt: '2026-09-15T10:00:00Z', contractVersion: 'wp313.v1' };

describe('asset evidence contracts', () => {
  it('keeps ad and asset versions separate and excludes transport material', () => {
    expect(AssetModerationObservation.parse(observation).assetIdentity).toBeNull();
    expect(AssetModerationObservation.safeParse({ ...observation, url: 'https://example.invalid' }).success).toBe(false);
    expect(AssetModerationObservation.safeParse({ ...observation, source: 'unified_pre_moderation_v1' }).success).toBe(false);
  });
  it.each(['pending', 'rejected', 'unknown'])('refuses selection with %s evidence', (status) => {
    expect(AssetEligibilityEvidence.safeParse({ context, identity, canRun: 'eligible', selectable: true,
      status, evidenceState: 'measured', reasons: [], observedAt: observation.observedAt }).success).toBe(false);
  });
  it.each(['missing', 'partial', 'stale'])('refuses selection with %s completeness', (evidenceState) => {
    expect(AssetEligibilityEvidence.safeParse({ context, identity, canRun: 'eligible', selectable: true,
      status: 'approved', evidenceState, reasons: [], observedAt: observation.observedAt }).success).toBe(false);
  });
  it('requires checksum/type/size manifest and counted batch correspondence', () => {
    expect(AssetLibraryUploadManifest.safeParse({ fileName: '../asset.png', contentType: 'image/png', byteLength: 8, sha256: 'a'.repeat(64) }).success).toBe(false);
    const batch = { scope: context.scope, requestId: 'synthetic-request', status: 'complete',
      items: [{ index: 0, kind: 'accepted', identity }, { index: 1, kind: 'refused' }],
      counts: { submitted: 2, accepted: 1, processing: 0, refused: 1 } };
    expect(AssetLibraryBatchStatus.safeParse(batch).success).toBe(true);
    expect(AssetLibraryBatchStatus.safeParse({ ...batch, items: [batch.items[0], batch.items[0]] }).success).toBe(false);
  });
});
