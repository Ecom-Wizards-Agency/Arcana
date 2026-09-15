import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import { OneTimeRpcPreviewRequest, OneTimeRpcSnapshot, REFERENCE_METHOD, COORDINATED_METHOD } from '@wizard-ads/shared';
import { PostgresManualRecommendationAdmission } from './recommendations-run.js';
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
    version: 1, method: 'sp.reference-efficiency', targetAcos: 0.37,
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

  it('keeps historical snapshot digests while normalizing their method on read', async () => {
    const canonical = freezeOneTimeRpcSnapshot(request.configuration, 'UTC', new Date('2024-03-01T09:00:00Z'));
    const historical = { ...canonical, configuration: { ...canonical.configuration, method: 'rpc' } };
    const rows = await database.sql<{ fingerprint: string }[]>`
      select app.one_time_rpc_snapshot_fingerprint(value) as fingerprint
        from jsonb_array_elements(${JSON.stringify([historical, canonical])}::jsonb)
    `;
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.fingerprint)).toEqual([
      oneTimeRpcSnapshotFingerprint(historical), oneTimeRpcSnapshotFingerprint(canonical),
    ]);
    expect(rows[0]!.fingerprint).not.toBe(rows[1]!.fingerprint);
    expect(OneTimeRpcSnapshot.parse(historical)).toEqual(canonical);
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

  it('freezes campaign method choices in the exact child admission and refuses changed-input replay', async () => {
    const actor = { orgId: '', userId: randomUUID() };
    const [tenant] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture(${randomUUID()},${actor.userId},'owner') as id`;
    actor.orgId = tenant!.id;
    const [profile] = await database.sql<{ id: string }[]>`select id::text from public.ad_profiles where org_id=${actor.orgId}::uuid`;
    const profileId = profile!.id;
    await database.sql`insert into public.campaigns (org_id,profile_id,amazon_id,ad_product,name,state,budget_amount,budget_type)
      values (${actor.orgId}::uuid,${profileId}::uuid,'synthetic-second','SP','Synthetic second campaign','enabled',20,'daily')`;
    const revision = 'c'.repeat(40);
    const session = await database.sql.reserve();
    try {
      await session`set session authorization service_role`;
      await session`select public.block_recommendation_admission(0)`;
      await session`select public.activate_recommendation_fenced_claims(1,${revision})`;
      await session`select public.authorize_recommendation_scoped_admission(2,${revision})`;
      await session`reset session authorization`;
      await session`set session authorization openspell_recommendation_worker`;
      await session`select public.report_recommendation_runtime('synthetic-method-admission',${revision},array[1,2],true)`;
    } finally { await session`reset session authorization`; session.release(); }
    const admission = new PostgresManualRecommendationAdmission(database);
    const selected = { profileId, clientRequestId: randomUUID(), scope: { mode: 'selected' as const, campaignIds: ['c-1', 'synthetic-second'] },
      oneTimeConfiguration: request.configuration, oneTimeReadiness: { ready: true as const, mode: 'fenced' as const },
      campaignMethods: { 'c-1': REFERENCE_METHOD, 'synthetic-second': COORDINATED_METHOD } };
    const first = await admission.enqueuePreviewBatch(actor, selected);
    await expect(admission.enqueuePreviewBatch(actor, { profileId, clientRequestId: randomUUID(),
      scope: selected.scope, campaignMethods: selected.campaignMethods })).rejects.toMatchObject({ code: 'invalid_request' });
    const read = () => database.sql<{ campaign_ids: string[]; admission: { campaignMethods: Record<string, unknown> }; snapshot: unknown }[]>`
      select array(select campaign_id from public.recommendation_run_campaigns member where member.run_id=run.id order by campaign_id) as campaign_ids,
        schedule_context->'methodAdmission' as admission,execution_snapshot as snapshot from public.recommendation_runs run
      where org_id=${actor.orgId}::uuid and profile_id=${profileId}::uuid and batch_id=${first.batchId}::uuid order by run.id`;
    const before = await read();
    expect(before).toHaveLength(first.childCount);
    expect(before.flatMap((child) => child.campaign_ids).sort()).toEqual(['c-1', 'synthetic-second']);
    for (const child of before) {
      expect(Object.keys(child.admission.campaignMethods).sort()).toEqual(child.campaign_ids);
      expect(child.admission.campaignMethods).toEqual(Object.fromEntries(child.campaign_ids.map((campaignId) =>
        [campaignId, selected.campaignMethods[campaignId as keyof typeof selected.campaignMethods]])));
    }
    expect(await admission.enqueuePreviewBatch(actor, { ...selected,
      scope: { mode: 'selected', campaignIds: [...selected.scope.campaignIds].reverse() },
      campaignMethods: { 'synthetic-second': COORDINATED_METHOD, 'c-1': REFERENCE_METHOD } })).toEqual(first);
    await expect(admission.enqueuePreviewBatch(actor, { ...selected,
      campaignMethods: { ...selected.campaignMethods, 'c-1': COORDINATED_METHOD } })).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect(await read()).toEqual(before);
    await expect(database.sql`update public.recommendation_runs set schedule_context=jsonb_set(schedule_context,
      '{methodAdmission,campaignMethods}',${JSON.stringify({ 'c-1': COORDINATED_METHOD })}::jsonb)
      where batch_id=${first.batchId}::uuid`).rejects.toThrow();
    expect(await read()).toEqual(before);
  }, 60_000);
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

  it('binds explicit campaign methods while preserving selection and map ordering', () => {
    const selected = { ...request, campaignMethods: { 'synthetic-a': REFERENCE_METHOD, 'synthetic-b': COORDINATED_METHOD } };
    const selectedFingerprint = oneTimePreviewRequestFingerprint(orgId, actorId, selected);
    expect(selectedFingerprint).not.toBe(original);
    expect(oneTimePreviewRequestFingerprint(orgId, actorId, { ...selected,
      campaignMethods: { 'synthetic-b': COORDINATED_METHOD, 'synthetic-a': REFERENCE_METHOD } })).toBe(selectedFingerprint);
    expect(oneTimePreviewRequestFingerprint(orgId, actorId, { ...selected,
      campaignMethods: { ...selected.campaignMethods, 'synthetic-a': COORDINATED_METHOD } })).not.toBe(selectedFingerprint);
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
