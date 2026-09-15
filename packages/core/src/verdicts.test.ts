import { expect, it } from 'vitest';
import type { VerdictEvidence, VerdictThresholds } from '@wizard-ads/shared';
import { classifyPerformanceVerdict } from './verdicts.js';

// Synthetic settings supplied as inputs; these values are never runtime defaults.
const settings: VerdictThresholds = { ownedRank: 2, rankGap: 20, targetAcos: 1 / 3 };
const evidence: VerdictEvidence = { clicks: 23, spend: 17, acos: 1 / 4, organicRank: 10, topOfSearchShare: null };
it.each([
  ['Paying for rank we own', { organicRank: 1 }],
  ['Rank gap', { organicRank: 52 }],
  ['Ranked, unfunded', { organicRank: 10, spend: 0, clicks: 0, acos: null }],
  ['Efficient', { organicRank: null }],
  ['Insufficient evidence', { acos: 1 / 2 }],
] as const)('classifies %s from supplied settings', (diagnosis, changes) => {
  expect(classifyPerformanceVerdict({ ...evidence, ...changes }, settings).diagnosis).toBe(diagnosis);
});
it('refuses missing thresholds with the precise reason', () => {
  expect(classifyPerformanceVerdict(evidence, null)).toEqual({ diagnosis: 'Insufficient evidence', reason: 'no threshold configured' });
  for (const key of Object.keys(settings)) {
    expect(classifyPerformanceVerdict(evidence, { ...settings, [key]: null }).reason).toBe('no threshold configured');
  }
});
it('does not treat missing spend as measured zero', () => {
  expect(classifyPerformanceVerdict({ ...evidence, spend: null }, settings).diagnosis).toBe('Insufficient evidence');
});
