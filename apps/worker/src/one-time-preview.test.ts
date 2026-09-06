import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
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

const databaseReady = await databaseAvailable();
describe.skipIf(!databaseReady)('one-time snapshot database contract', () => {
  let database: TestDatabase;
  beforeAll(async () => { database = await createTestDatabase('one_time_snapshot'); });
  afterAll(async () => { if (database) await database.drop(); });

  it.each([
    { bidFloor: 0.13, bidCeiling: 4.7, bidIncreaseCap: 0.23 },
    { bidFloor: 0, bidCeiling: 1e24, bidIncreaseCap: 1e-9 },
    { bidFloor: -0, bidCeiling: 0.13, bidIncreaseCap: 0 },
  ])('matches the worker fingerprint using actual PostgreSQL float8 encoding %#', async (patch) => {
    const snapshot = freezeOneTimeRpcSnapshot({ ...request.configuration, ...patch }, 'Asia/Bangkok',
      new Date('2024-03-01T09:00:00Z'));
    const rows = await database.sql<{ valid: boolean; fingerprint: string }[]>`
      select app.one_time_rpc_snapshot_valid(${JSON.stringify(snapshot)}::jsonb) as valid,
             app.one_time_rpc_snapshot_fingerprint(${JSON.stringify(snapshot)}::jsonb) as fingerprint
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ valid: true, fingerprint: oneTimeRpcSnapshotFingerprint(snapshot) });
  });

  it('refuses unknown fields, invalid dates, missing values and inconsistent profile calendars', async () => {
    const snapshot = freezeOneTimeRpcSnapshot(request.configuration, 'UTC', new Date('2024-03-01T09:00:00Z'));
    const invalid = [
      { ...snapshot, ignored: true },
      { ...snapshot, profileToday: '2024-03-02' },
      { ...snapshot, profileTimezone: 'Invalid/Timezone' },
      { ...snapshot, configuration: { ...snapshot.configuration, targetAcos: null } },
      { ...snapshot, configuration: { ...snapshot.configuration, bidFloor: 10 } },
      { ...snapshot, configuration: { ...snapshot.configuration, bidDecreaseCap: 1.1 } },
      { ...snapshot, configuration: { ...snapshot.configuration, window: { start: '2023-02-29', end: '2024-02-29' } } },
    ];
    const rows = await database.sql<{ valid: boolean }[]>`
      select app.one_time_rpc_snapshot_valid(value) as valid
        from jsonb_array_elements(${JSON.stringify(invalid)}::jsonb)
    `;
    expect(rows).toHaveLength(invalid.length);
    expect(rows.every((row) => row.valid === false)).toBe(true);
  });
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
