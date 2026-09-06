import { describe, expect, it } from 'vitest';
import { JobPayload, RecommendationsExecutionJob, RecommendationsRunJob } from './jobs.js';

const identity = {
  type: 'recommendations.run',
  orgId: '00000000-0000-4000-8000-000000000001',
  profileId: '00000000-0000-4000-8000-000000000002',
  runId: '00000000-0000-4000-8000-000000000003',
};
const oneTime = { ...identity, executionVersion: 2, snapshotFingerprint: 'a'.repeat(64) };

describe('recommendation execution compatibility', () => {
  it('preserves scheduled and historical payloads unchanged', () => {
    const legacy = { ...identity, lookbackDays: 7 };
    expect(RecommendationsExecutionJob.parse(legacy)).toEqual(legacy);
    expect(JobPayload.parse(legacy)).toEqual(legacy);
  });

  it('accepts explicit snapshot custody in the existing queue lane', () => {
    expect(RecommendationsExecutionJob.parse(oneTime)).toEqual(oneTime);
    expect(JobPayload.parse(oneTime)).toEqual(oneTime);
  });

  it('cannot be interpreted by the unchanged legacy parser', () => {
    expect(RecommendationsRunJob.safeParse(oneTime).success).toBe(false);
  });

  it.each([
    { ...oneTime, lookbackDays: 7 },
    { ...oneTime, executionVersion: 3, lookbackDays: 7 },
    { ...oneTime, snapshotFingerprint: 'invalid', lookbackDays: 7 },
    { ...oneTime, executionVersion: undefined, lookbackDays: 7 },
    { ...oneTime, snapshotFingerprint: undefined },
    { ...oneTime, configuration: {} },
  ])('refuses mixed, future, or incomplete formats without legacy fallback %#', (payload) => {
    expect(RecommendationsExecutionJob.safeParse(payload).success).toBe(false);
    expect(JobPayload.safeParse(payload).success).toBe(false);
  });
});
