import { describe, expect, it } from 'vitest';
import { OneTimeRpcPreviewRequest } from '@wizard-ads/shared';
import {
  freezeOneTimeRpcSnapshot,
  oneTimePreviewRequestFingerprint,
  oneTimeRpcSnapshotFingerprint,
  oneTimeRpcWindowDays,
} from './one-time-preview.js';

const orgId = '00000000-0000-4000-8000-000000000001';
const actorId = '00000000-0000-4000-8000-000000000002';
const request = OneTimeRpcPreviewRequest.parse({
  version: 1,
  profileId: '00000000-0000-4000-8000-000000000003',
  clientRequestId: '00000000-0000-4000-8000-000000000004',
  scope: { mode: 'selected', campaignIds: ['synthetic-b', 'synthetic-a'] },
  configuration: {
    version: 1, method: 'rpc', targetAcos: 0.37,
    bidFloor: 0.13, bidCeiling: 4.7, bidIncreaseCap: 0.23, bidDecreaseCap: 0.41,
    window: { start: '2024-02-01', end: '2024-02-29' },
  },
});

describe('one-time preview immutable identity', () => {
  const original = oneTimePreviewRequestFingerprint(orgId, actorId, request);

  it('normalizes selection ordering and object-key ordering', () => {
    expect(oneTimePreviewRequestFingerprint(orgId, actorId, {
      ...request,
      scope: { mode: 'selected', campaignIds: ['synthetic-a', 'synthetic-b'] },
      configuration: { ...Object.fromEntries(Object.entries(request.configuration).reverse()) } as typeof request.configuration,
    })).toBe(original);
  });

  it.each(['targetAcos', 'bidFloor', 'bidCeiling', 'bidIncreaseCap', 'bidDecreaseCap'] as const)(
    'binds retry identity to %s', (field) => {
      expect(oneTimePreviewRequestFingerprint(orgId, actorId, {
        ...request, configuration: { ...request.configuration, [field]: request.configuration[field] + 0.01 },
      })).not.toBe(original);
    },
  );

  it('binds identity to organization, actor, profile, selection and reporting dates', () => {
    const other = '00000000-0000-4000-8000-000000000009';
    const changed = [
      oneTimePreviewRequestFingerprint(other, actorId, request),
      oneTimePreviewRequestFingerprint(orgId, other, request),
      oneTimePreviewRequestFingerprint(orgId, actorId, { ...request, profileId: other }),
      oneTimePreviewRequestFingerprint(orgId, actorId, { ...request, scope: { mode: 'all' } }),
      oneTimePreviewRequestFingerprint(orgId, actorId, {
        ...request, scope: { mode: 'selected', campaignIds: ['synthetic-a'] },
      }),
      oneTimePreviewRequestFingerprint(orgId, actorId, {
        ...request, configuration: { ...request.configuration, window: { start: '2024-02-02', end: '2024-02-29' } },
      }),
    ];
    expect(changed).toHaveLength(6);
    expect(new Set([original, ...changed]).size).toBe(7);
  });

  it('freezes leap-day dates in profile time and cannot silently replace them after midnight', () => {
    // March 1 UTC is still February 29 at this advertising profile.
    expect(() => freezeOneTimeRpcSnapshot(request.configuration, 'America/Los_Angeles',
      new Date('2024-03-01T01:00:00Z'))).toThrow();
    const snapshot = freezeOneTimeRpcSnapshot(request.configuration, 'America/Los_Angeles',
      new Date('2024-03-01T09:00:00Z'));
    expect(snapshot.profileToday).toBe('2024-03-01');
    expect(oneTimeRpcWindowDays(snapshot)).toBe(29);
    const later = freezeOneTimeRpcSnapshot(request.configuration, 'America/Los_Angeles',
      new Date('2024-03-02T09:00:00Z'));
    expect(later.configuration.window).toEqual(snapshot.configuration.window);
    expect(oneTimeRpcSnapshotFingerprint(later)).not.toBe(oneTimeRpcSnapshotFingerprint(snapshot));
  });

  it('refuses an invalid profile timezone instead of silently using UTC', () => {
    expect(() => freezeOneTimeRpcSnapshot(request.configuration, 'Invalid/Timezone',
      new Date('2024-03-01T09:00:00Z'))).toThrow();
  });
});
