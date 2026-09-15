import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AssetLibraryObservation, AssetModerationObservation, ProviderGraphAssociation } from '@wizard-ads/shared';
import { createTestDatabase, type TestDatabase } from '../testing/harness.js';
import { asUser } from '../testing/rls.js';
import { persistAssetLibraryEvidence, persistAssetModerationEvidence, readAssetEvidence } from './asset-evidence.js';

const observedAt = '2026-09-15T10:00:00Z', expiresAt = '2026-09-16T10:00:00Z';
const scope = { region: 'NA', amazonProfileId: '1000000001' } as const;
const identity = { assetId: 'asset-one', version: 'v1' };
const asset: AssetLibraryObservation = { scope, identity, observedAt, assetType: 'video', name: 'Synthetic', processing: 'processing',
  specChecks: { approvedPrograms: ['SPONSORED_BRANDS_VIDEO'], failedSpecChecks: [] }, mediaMetadata: { byteLength: 100, contentType: 'video/mp4', width: 100, height: 100, durationSeconds: 12 } };
const moderation: AssetModerationObservation = { context: { scope, marketplace: 'US', program: 'SB_VIDEO' },
  subject: { kind: 'ad', adId: 'ad-one', adVersion: 'creative-v1' }, assetIdentity: identity, stage: 'final', source: 'moderation_v4', status: 'approved', reasons: [], observedAt, contractVersion: 'wp313.v1' };

describe('asset evidence durable custody', () => {
  let db: TestDatabase; const userId = randomUUID(), outsider = randomUUID(); let orgId: string, profileId: string;
  const owner = () => ({ orgId, profileId });
  const read = (now = '2026-09-15T12:00:00Z') => readAssetEvidence(db, { ...owner(), now });
  beforeAll(async () => {
    db = await createTestDatabase('asset_evidence');
    const [org] = await db.sql<{ id: string }[]>`select app.seed_tenant_fixture('asset-evidence',${userId},'owner','2026-09-15') as id`; orgId = org!.id;
    const [profile] = await db.sql<{ id: string }[]>`select id from public.ad_profiles where org_id=${orgId} order by id limit 1`; profileId = profile!.id;
    await db.sql`update public.ad_profiles set amazon_profile_id=${scope.amazonProfileId} where id=${profileId}`;
    await db.sql`insert into auth.users(id) values(${outsider}) on conflict do nothing`;
    await db.sql`delete from public.asset_moderation_observations where org_id=${orgId};`;
    await db.sql`delete from public.asset_library_observations where org_id=${orgId};`;
    await db.sql`delete from public.asset_library_versions where org_id=${orgId};`;
  }, 120_000);
  afterAll(async () => { await db?.drop(); }, 120_000);
  it('stores immutable versions, records processing transitions and independently verifies counted replay', async () => {
    const initial = { observation: asset, expiresAt };
    expect(await persistAssetLibraryEvidence(db, owner(), [initial, initial])).toEqual({ source: 2, duplicates: 1, canonical: 1, stored: 1, existing: 0, verified: 1, unresolved: 0 });
    expect(await persistAssetLibraryEvidence(db, owner(), [initial])).toMatchObject({ stored: 0, existing: 1, verified: 1 });
    await persistAssetLibraryEvidence(db, owner(), [{ observation: { ...asset, processing: 'active', observedAt: '2026-09-15T11:00:00Z' }, expiresAt }]);
    const [versions] = await db.sql<{ count: number }[]>`select count(*)::int as count from public.asset_library_versions where org_id=${orgId}`;
    const [observations] = await db.sql<{ count: number }[]>`select count(*)::int as count from public.asset_library_observations where org_id=${orgId}`;
    expect(versions?.count).toBe(1); expect(observations?.count).toBe(2);
    expect((await read()).assets[0]?.processing).toBe('active');
  });
  it('rolls back content conflicts and rejects authenticated scope mismatch', async () => {
    await expect(persistAssetLibraryEvidence(db, owner(), [{ observation: { ...asset, mediaMetadata: { ...asset.mediaMetadata!, byteLength: 200 } }, expiresAt }])).rejects.toThrow('content conflict');
    await expect(persistAssetLibraryEvidence(db, owner(), [{ observation: { ...asset, scope: { ...scope, amazonProfileId: '1000000002' } }, expiresAt }])).rejects.toThrow('scope mismatch');
    const [count] = await db.sql<{ count: number }[]>`select count(*)::int as count from public.asset_library_observations where org_id=${orgId}`;
    expect(count?.count).toBe(2);
  });
  it('retains unresolved moderation and only associates after exact graph edge resolution', async () => {
    expect(await persistAssetModerationEvidence(db, owner(), [{ observation: moderation, expiresAt }])).toMatchObject({ stored: 1, unresolved: 1, verified: 1 });
    expect((await read()).unresolvedCount).toBe(1);
    const edge: ProviderGraphAssociation = { scope: { ...owner(), amazonProfileId: scope.amazonProfileId, region: 'NA' },
      from: { adProduct: 'SB', kind: 'ad', providerId: 'ad-one', version: 'creative-v1' }, to: { adProduct: 'SB', kind: 'asset', providerId: identity.assetId, version: identity.version },
      relation: 'asset', sourceEventAt: observedAt, revision: '1', payloadFingerprint: 'b'.repeat(64), operation: 'upsert' };
    for (const [index, identity] of [edge.from, edge.to].entries()) {
      const node = { scope: edge.scope, identity, source: 'product_api', contractVersion: 'wp313.v1', sourceEventAt: observedAt,
        observedAt, revision: '1', payloadFingerprint: 'a'.repeat(64), operation: 'upsert', state: 'enabled' };
      await db.sql`insert into public.provider_graph_observations(org_id,profile_id,identity,entity_key,observation,source_event_at,observed_at,expires_at)
        values(${orgId},${profileId},${`asset-node-${index}`},
          ${JSON.stringify(identity)},${JSON.stringify(node)}::jsonb,
          ${observedAt},${observedAt},${expiresAt})`;
    }
    await db.sql`insert into public.provider_entity_associations(org_id,profile_id,identity,association,resolution,observed_at,expires_at)
      values(${orgId},${profileId},'asset-association',${JSON.stringify(edge)}::jsonb,'resolved',${observedAt},${expiresAt})`;
    expect(await persistAssetModerationEvidence(db, owner(), [{ observation: moderation, expiresAt }])).toMatchObject({ stored: 1, unresolved: 0, verified: 1 });
    const result = await read(); expect(result.moderationObservations.filter((item) => item.observation.assetIdentity !== null)).toHaveLength(1);
    expect(result.moderationCount).toBe(2); expect(result.unresolvedCount).toBe(1);
  });
  it('preserves rejection transitions, refuses another marketplace, and does not renew freshness on replay', async () => {
    const rejected = { ...moderation, status: 'rejected' as const, reasons: ['Prohibited content.'], observedAt: '2026-09-15T11:30:00Z' };
    expect(await persistAssetModerationEvidence(db, owner(), [{ observation: rejected, expiresAt }])).toMatchObject({ stored: 1, verified: 1 });
    expect((await read()).moderationObservations.some((row) => row.observation.status === 'rejected' && row.observation.reasons[0] === 'Prohibited content.')).toBe(true);
    await expect(persistAssetModerationEvidence(db, owner(), [{ observation: { ...moderation, context: { ...moderation.context, marketplace: 'GB' } }, expiresAt }])).rejects.toThrow('marketplace');
    await persistAssetModerationEvidence(db, owner(), [{ observation: rejected, expiresAt: '2026-09-20T10:00:00Z' }]);
    expect((await read('2026-09-17T10:00:00Z')).moderationObservations.filter((row) => row.observation.status === 'rejected').every((row) => row.expiresAt === new Date(expiresAt).toISOString())).toBe(true);
  });
  it('refuses previously resolved moderation after an endpoint tombstone', async () => {
    const [existing] = await db.sql<{ observation: Record<string, unknown> }[]>`select observation from public.provider_graph_observations where identity='asset-node-0' and org_id=${orgId}`;
    const tombstone = { ...existing!.observation, operation: 'tombstone', sourceEventAt: '2026-09-15T11:45:00Z', revision: '2' };
    await db.sql`insert into public.provider_graph_observations(org_id,profile_id,identity,entity_key,observation,source_event_at,observed_at,expires_at)
      values(${orgId},${profileId},'asset-node-tombstone','ad-one',${JSON.stringify(tombstone)}::jsonb,'2026-09-15T11:45:00Z',${observedAt},${expiresAt})`;
    expect((await read()).moderationObservations.every((row) => row.observation.assetIdentity === null)).toBe(true);
  });
  it('quarantines tied asset observations instead of choosing active by fingerprint order', async () => {
    await persistAssetLibraryEvidence(db, owner(), [{ observation: { ...asset, processing: 'archived', observedAt: '2026-09-15T11:00:00Z' }, expiresAt }]);
    const result = await read(); expect(result.assets).toHaveLength(0); expect(result.refusedCount).toBe(2);
  });
  it('enforces tenant RLS and immutable anchors', async () => {
    const rows = await asUser(db, userId, (sql) => sql`select asset_id from public.asset_library_versions where org_id=${orgId}`); expect(rows).toHaveLength(1);
    const denied = await asUser(db, outsider, (sql) => sql`select asset_id from public.asset_library_versions where org_id=${orgId}`); expect(denied).toHaveLength(0);
    await expect(asUser(db, outsider, (sql) => readAssetEvidence({ sql }, { ...owner(), now: observedAt }))).rejects.toThrow('ownership');
    await expect(db.sql`update public.asset_library_versions set version='mutated' where org_id=${orgId}`).rejects.toThrow('immutable');
  });
});
