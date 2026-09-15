import { expect, it } from 'vitest';
import { AdGroupProductAssignmentInput, AdGroupProductAssignmentScope, AdGroupProductAssignmentList } from './entities';
const profileId = '00000000-0000-4000-8000-000000000001';
it('validates dates, ASINs and refuses caller-supplied authority', () => {
  expect(AdGroupProductAssignmentScope.safeParse({ profileId, start: '2026-02-30', end: '2026-03-01' }).success).toBe(false);
  expect(AdGroupProductAssignmentScope.safeParse({ profileId, start: '2026-03-02', end: '2026-03-01' }).success).toBe(false);
  expect(AdGroupProductAssignmentInput.safeParse({ profileId, adGroupId: 'synthetic-group', asin: 'B000000001' }).success).toBe(true);
  expect(AdGroupProductAssignmentInput.safeParse({ profileId, adGroupId: 'synthetic-group', asin: 'B000000001', assignedBy: profileId }).success).toBe(false);
});
it('asserts list counts and distinguishes missing spend from zero', () => {
  const value = { profileId, start: '2026-03-01', end: '2026-03-02', canAssign: true, days: 2, items: [{ adGroupId: 'synthetic-group', campaignId: 'synthetic-campaign', name: null, asins: ['B000000001','B000000002'], assignedAsin: null, spend: null }], count: 1, unassignedCount: 0, unassignedSpend: 0 };
  expect(AdGroupProductAssignmentList.parse(value).items[0]?.spend).toBeNull();
  expect(AdGroupProductAssignmentList.safeParse({ ...value, count: 0 }).success).toBe(false);
  expect(AdGroupProductAssignmentList.safeParse({ ...value, unassignedSpend: 10 }).success).toBe(false);
});
