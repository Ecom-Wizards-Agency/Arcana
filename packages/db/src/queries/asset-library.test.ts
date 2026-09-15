import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AssetLibrarySnapshot } from '@wizard-ads/shared/asset-library';
import { createTestDatabase, type TestDatabase } from '../testing/harness.js';
import { withAuthenticatedReadSnapshot } from './authenticated-actor.js';
import { readAssetLibraryJobSnapshot, readAssetLibrarySnapshot, recordAssetLibrarySnapshot } from './asset-library.js';
describe('asset library snapshots', () => {
  let db: TestDatabase; let profileId: string; let amazonProfileId: string; let snapshot: AssetLibrarySnapshot;
  const actor = { orgId: '', userId: randomUUID() }; const other = { orgId: '', userId: randomUUID() };
  beforeAll(async () => {
    db = await createTestDatabase('builder_assets');
    for (const [index, current] of [actor, other].entries()) { const [row] = await db.sql<{ id: string }[]>`select app.seed_tenant_fixture(${'asset-builder-' + index},${current.userId},'owner') as id`; current.orgId = row!.id; }
    const [profile] = await db.sql<{ id: string; amazon_profile_id: string }[]>`select id,amazon_profile_id from public.ad_profiles where org_id=${actor.orgId} and region='NA' limit 1`;
    profileId = profile!.id; amazonProfileId = '270';
    await db.sql`update public.ad_profiles set amazon_profile_id=${amazonProfileId} where id=${profileId}`;
    snapshot = AssetLibrarySnapshot.parse({ id: randomUUID(), profileId, observedAt: '2026-06-10T00:00:00.000Z', sourceRows: 1, persistedRows: 1,
      assets: [{ observation: { scope: { region: 'NA', amazonProfileId }, identity: { assetId: 'synthetic-asset', version: '1' }, observedAt: '2026-06-10T00:00:00.000Z', assetType: 'video', name: 'Synthetic asset', processing: 'active', specChecks: { approvedPrograms: null, failedSpecChecks: null } }, durationSeconds: null, thumbnailUrl: 'https://example.test/thumbnail', thumbnailExpiresAt: '2026-06-11T00:00:00.000Z', usedInCampaignIds: [] }] });
  }, 60_000);
  afterAll(async () => { await db?.drop(); });
  it('atomically stores, counts, reads and replays all rows including timestamp precision', async () => {
    expect(await recordAssetLibrarySnapshot(db, actor.orgId, snapshot)).toEqual({ persistedRows: 1, verifiedRows: 1 });
    expect(await recordAssetLibrarySnapshot(db, actor.orgId, snapshot)).toEqual({ persistedRows: 1, verifiedRows: 1 });
    expect((await readAssetLibraryJobSnapshot(db, actor.orgId, profileId, snapshot.id))?.assets).toHaveLength(1);
    expect((await withAuthenticatedReadSnapshot(db, actor, (tx) => readAssetLibrarySnapshot(tx, profileId)))?.assets[0]?.observation.identity).toEqual(snapshot.assets[0]!.observation.identity);
  });
  it('refuses replacement observations and isolates tenants', async () => {
    await expect(recordAssetLibrarySnapshot(db, actor.orgId, { ...snapshot, observedAt: '2026-06-12T00:00:00.000Z' })).rejects.toThrow();
    expect(await withAuthenticatedReadSnapshot(db, other, (tx) => readAssetLibrarySnapshot(tx, profileId))).toBeNull();
    await expect(recordAssetLibrarySnapshot(db, other.orgId, { ...snapshot, id: randomUUID() })).rejects.toThrow('scope');
  });
  it('retains the latest empty snapshot as a completed observation', async () => {
    await recordAssetLibrarySnapshot(db, actor.orgId, { ...snapshot, id: randomUUID(), observedAt: '2026-06-13T00:00:00.000Z', sourceRows: 0, persistedRows: 0, assets: [] });
    expect((await withAuthenticatedReadSnapshot(db, actor, (tx) => readAssetLibrarySnapshot(tx, profileId)))?.assets).toEqual([]);
  });
});
