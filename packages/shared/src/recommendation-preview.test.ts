import { describe, expect, it } from 'vitest';
import { RecommendationPreviewAccepted, RecommendationPreviewBatchStatus } from './recommendation-preview.js';

const child = { runId: 'historical-run', groupName: null, status: 'succeeded', campaignCount: 2, proposalsCount: 3 };
const historical = { batchId: 'historical-batch', status: 'succeeded', campaignCount: 2, proposalsCount: 3, children: [child] };

describe('preview HTTP count closure', () => {
  it('keeps historical responses readable without inventing configuration or diagnostics', () => {
    expect(RecommendationPreviewBatchStatus.parse(historical)).toEqual(historical);
  });
  it('refuses lost, repeated, or miscounted children', () => {
    for (const value of [
      { ...historical, children: [] },
      { ...historical, campaignCount: 3 },
      { ...historical, proposalsCount: 4 },
      { ...historical, campaignCount: 4, proposalsCount: 6, children: [child, child] },
    ]) expect(RecommendationPreviewBatchStatus.safeParse(value).success).toBe(false);
  });
  it('preserves actionable empty outcomes with counted diagnostics', () => {
    const empty = { ...historical, proposalsCount: 0, children: [{ ...child, proposalsCount: 0,
      outcome: 'empty', detail: 'No target reports are available for the confirmed period.' }] };
    expect(RecommendationPreviewBatchStatus.parse(empty)).toEqual(empty);
  });
  it('refuses an acceptance count that requires empty child scopes', () => {
    expect(RecommendationPreviewAccepted.safeParse({ batchId: 'batch', status: 'queued', childCount: 2,
      scope: { mode: 'all', campaignCount: 1, fingerprint: 'a'.repeat(64) } }).success).toBe(false);
  });
});
