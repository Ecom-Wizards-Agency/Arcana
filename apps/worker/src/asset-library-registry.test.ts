import { describe, expect, it, vi } from 'vitest';
import { createDb, persistAssetLibraryEvidence, readAssetLibraryJobSnapshot, recordAssetLibrarySnapshot, type ClaimedJob } from '@wizard-ads/db';
import { JobPayload } from '@wizard-ads/shared';
import { registerAssetLibrarySource } from './asset-library.js';
import { IngestionRegistry } from './ingestion-registry.js';
vi.mock('@wizard-ads/db', async (original) => ({ ...await original<object>(), persistAssetLibraryEvidence: vi.fn(async () => ({source:0,duplicates:0,canonical:0,stored:0,existing:0,verified:0,unresolved:0})), readAssetLibraryJobSnapshot: vi.fn(async () => null), recordAssetLibrarySnapshot: vi.fn(async () => ({ persistedRows: 0, verifiedRows: 0 })) }));
describe('asset-library production registry binding', () => {
  it('dispatches the registered job, persists the snapshot and publishes matching read counts', async () => {
    const orgId = '27000000-0000-4000-8000-000000000001'; const profileId = '27000000-0000-4000-8000-000000000002';
    const payload = JobPayload.parse({ type: 'asset-library.search', orgId, profileId });
    const job: ClaimedJob = { id: '27000000-0000-4000-8000-000000000003', orgId, profileId, jobType: payload.type, payload, attempts: 1, maxAttempts: 2, dedupeKey: null, claim: null, claimedBy: 'synthetic' };
    const reader = { probeCreativeAssetsPage: vi.fn(async () => ({ sourceRows: 0, totalRecords: 0, nextToken: null, items: [] })), probeSbAdsPage: vi.fn(async () => ({ sourceRows: 0, totalResults: 0, nextToken: null, items: [] })) };
    const coverage = vi.fn(async () => ({ offered: 1, written: 1, unchanged: 0 })); const registry = new IngestionRegistry(coverage);
    const db = createDb({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5529/postgres' });
    try {
      registerAssetLibrarySource(registry, db, reader, () => '2026-06-10T00:00:00.000Z');
      expect(await registry.dispatch({ job, payload, profile: { id: profileId, orgId, amazonProfileId: '270', region: 'NA', currencyCode: 'USD', timezone: 'UTC' } })).toMatchObject({ sourceRows: 0, loadedRows: 0, refusedRows: 0 });
      expect(readAssetLibraryJobSnapshot).toHaveBeenCalledOnce(); expect(recordAssetLibrarySnapshot).toHaveBeenCalledOnce(); expect(persistAssetLibraryEvidence).toHaveBeenCalledOnce();
      expect(coverage).toHaveBeenCalledWith(expect.objectContaining({ reportType: 'asset_library_assets', coveredThrough: '2026-06-10', observedAt: '2026-06-10T00:00:00.000Z', countsMatch: true }), 0);
      expect(Object.keys(reader)).toEqual(['probeCreativeAssetsPage', 'probeSbAdsPage']);
    } finally { await db.close(); }
  });
});
