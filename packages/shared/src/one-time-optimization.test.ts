import { describe, expect, it } from 'vitest';
import {
  OneTimeRpcConfiguration,
  OneTimeRpcPreviewRequest,
  OneTimeRpcSnapshot,
} from './one-time-optimization.js';

const configuration = {
  version: 1,
  method: 'rpc',
  targetAcos: 0.37,
  bidFloor: 0.13,
  bidCeiling: 4.7,
  bidIncreaseCap: 0.23,
  bidDecreaseCap: 0.41,
  window: { start: '2024-02-01', end: '2024-02-29' },
};
const request = {
  version: 1,
  profileId: '00000000-0000-4000-8000-000000000001',
  clientRequestId: '00000000-0000-4000-8000-000000000002',
  scope: { mode: 'all' },
  configuration,
};

describe('one-time RPC contract', () => {
  it('accepts complete explicit settings without saved strategy or group assignment', () => {
    expect(OneTimeRpcPreviewRequest.parse(request)).toEqual(request);
    const selected = { ...request, scope: { mode: 'selected', campaignIds: ['synthetic-a', 'synthetic-b'] } };
    expect(OneTimeRpcPreviewRequest.parse(selected)).toEqual(selected);
  });

  it.each(Object.keys(configuration))('requires %s instead of inventing a default', (key) => {
    const missing: Record<string, unknown> = { ...configuration };
    delete missing[key];
    expect(OneTimeRpcConfiguration.safeParse(missing).success).toBe(false);
  });

  it.each([
    { version: 2 }, { method: 'saved_strategy' }, { targetAcos: 0 },
    { targetAcos: Number.NaN }, { targetAcos: Number.POSITIVE_INFINITY },
    { bidFloor: -1 }, { bidCeiling: 0 }, { bidFloor: 5 },
    { bidIncreaseCap: -0.1 }, { bidDecreaseCap: 1.01 },
    { window: { start: '2023-02-29', end: '2023-03-01' } },
    { window: { start: '2024-03-01', end: '2024-02-29' } },
    { groupId: request.profileId }, { enableSchedule: true },
  ])('refuses invalid or unrecognized settings %j', (patch) => {
    expect(OneTimeRpcConfiguration.safeParse({ ...configuration, ...patch }).success).toBe(false);
  });

  it.each([
    { mode: 'all', campaignIds: ['synthetic-a'] },
    { mode: 'selected', campaignIds: [] },
    { mode: 'selected', campaignIds: ['synthetic-a', 'synthetic-a'] },
    { mode: 'selected', campaignIds: [' synthetic-a'] },
    { mode: 'selected', campaignIds: [''] },
    { mode: 'selected', campaignIds: Array.from({ length: 10_001 }, (_, i) => `synthetic-${i}`) },
  ])('refuses ambiguous or oversized campaign scope %#', (scope) => {
    expect(OneTimeRpcPreviewRequest.safeParse({ ...request, scope }).success).toBe(false);
  });

  it('refuses unknown request fields and versions rather than discarding instructions', () => {
    expect(OneTimeRpcPreviewRequest.safeParse({ ...request, version: 2 }).success).toBe(false);
    expect(OneTimeRpcPreviewRequest.safeParse({ ...request, apply: true }).success).toBe(false);
  });

  it('freezes completed reporting days independently of a later execution time', () => {
    const snapshot = {
      version: 1,
      configuration,
      profileTimezone: 'America/Los_Angeles',
      admittedAt: '2024-03-01T12:00:00Z',
      profileToday: '2024-03-01',
    };
    expect(OneTimeRpcSnapshot.parse(snapshot)).toEqual(snapshot);
    expect(OneTimeRpcSnapshot.safeParse({ ...snapshot, profileToday: '2024-02-29' }).success).toBe(false);
    expect(OneTimeRpcSnapshot.safeParse({ ...snapshot, profileToday: '2024-02-28' }).success).toBe(false);
  });
});
