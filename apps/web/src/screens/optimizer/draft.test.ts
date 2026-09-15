// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { COORDINATED_METHOD, REFERENCE_METHOD, type OneTimeRpcConfiguration } from '@wizard-ads/shared';
import { clearOptimizerAdmission, optimizerAdmissionRequest } from './draft';

const profileId = '33333333-3333-4333-8333-333333333333';
const configuration: OneTimeRpcConfiguration = { version: 1, method: 'sp.reference-efficiency', targetAcos: 0.37,
  bidFloor: 0.11, bidCeiling: 4.3, bidIncreaseCap: 0.23, bidDecreaseCap: 0.41,
  window: { start: '2026-07-01', end: '2026-07-28' } };
afterEach(() => sessionStorage.clear());

it('recovers the same request identity from storage after reload and canonical reordering', () => {
  const first = optimizerAdmissionRequest(profileId, ['synthetic-b', 'synthetic-a'], configuration,
    { 'synthetic-b': COORDINATED_METHOD, 'synthetic-a': REFERENCE_METHOD });
  const restored = optimizerAdmissionRequest(profileId, ['synthetic-a', 'synthetic-b'], configuration,
    { 'synthetic-a': REFERENCE_METHOD, 'synthetic-b': COORDINATED_METHOD });
  expect(restored).toEqual(first);
  expect(sessionStorage.length).toBe(1);
});

it('narrows method selections to the selected campaigns and changes identity for a changed request', () => {
  const first = optimizerAdmissionRequest(profileId, ['synthetic-a'], configuration,
    { 'synthetic-a': REFERENCE_METHOD, 'synthetic-deselected': COORDINATED_METHOD });
  expect(first.campaignMethods).toEqual({ 'synthetic-a': REFERENCE_METHOD });
  const changed = optimizerAdmissionRequest(profileId, ['synthetic-a'], configuration, { 'synthetic-a': COORDINATED_METHOD });
  expect(changed.clientRequestId).not.toBe(first.clientRequestId);
  clearOptimizerAdmission(profileId, first.clientRequestId);
  expect(optimizerAdmissionRequest(profileId, ['synthetic-a'], configuration, { 'synthetic-a': COORDINATED_METHOD })).toEqual(changed);
  clearOptimizerAdmission(profileId, changed.clientRequestId);
  expect(optimizerAdmissionRequest(profileId, ['synthetic-a'], configuration, { 'synthetic-a': COORDINATED_METHOD }).clientRequestId).not.toBe(changed.clientRequestId);
});

it('validates profile identity before dispatch and keeps request recovery separate by profile', () => {
  expect(() => optimizerAdmissionRequest('invalid-profile', ['synthetic-a'], configuration)).toThrow();
  const first = optimizerAdmissionRequest(profileId, ['synthetic-a'], configuration);
  const other = optimizerAdmissionRequest('44444444-4444-4444-8444-444444444444', ['synthetic-a'], configuration);
  expect(other.clientRequestId).not.toBe(first.clientRequestId);
  expect(optimizerAdmissionRequest(profileId, ['synthetic-a'], configuration)).toEqual(first);
});
