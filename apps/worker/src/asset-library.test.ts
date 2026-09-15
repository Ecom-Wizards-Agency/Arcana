import { describe, expect, it, vi } from 'vitest';
import type { CreativeAssetProbePage, SbAdProbePage } from '@wizard-ads/ads-api';
import { AssetLibrarySnapshot } from '@wizard-ads/shared/asset-library';
import { executeAssetLibrarySearch } from './asset-library.js';
const id = (n: number) => `27000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const profile = { id: id(2), orgId: id(1), amazonProfileId: '270', region: 'NA' as const, currencyCode: 'USD', timezone: 'UTC' };
const library: CreativeAssetProbePage = { sourceRows: 1, totalRecords: 1, nextToken: null, items: [{ assetId: 'synthetic-asset', version: '1', assetType: 'VIDEO', name: 'Synthetic video', status: 'ACTIVE', contentHash: null, defaultUrl: null, thumbnailUrl: null, raw: {} }] };
const ads: SbAdProbePage = { sourceRows: 1, totalResults: 1, nextToken: null, items: [{ adId: 'synthetic-ad', campaignId: 'synthetic-campaign', adGroupId: 'synthetic-group', creativePresent: true, creativeVersion: '1', creativeType: 'VIDEO', name: 'Synthetic ad', state: 'PAUSED', videoAssets: [{ referenceId: 'synthetic-reference', assetId: 'synthetic-asset', version: '1', kind: 'asset_library' }], asins: [], raw: {} }] };
function setup() {
  let saved: AssetLibrarySnapshot | null = null;
  const reader = { probeCreativeAssetsPage: vi.fn(async () => library), probeSbAdsPage: vi.fn(async () => ads) };
  const persist = vi.fn(async (_org: string, snapshot: AssetLibrarySnapshot) => { saved = AssetLibrarySnapshot.parse(snapshot); return { persistedRows: snapshot.assets.length, verifiedRows: snapshot.assets.length }; });
  return { job: { type: 'asset-library.search' as const, orgId: id(1), profileId: id(2) }, jobId: id(3), profile, reader, persist,
    readExisting: vi.fn(async () => saved), now: () => '2026-06-10T00:00:00.000Z' };
}
describe('read-only asset-library observation job', () => {
  it('snapshots every observation and current video reference with reconciled counts', async () => {
    const input = setup(); const result = await executeAssetLibrarySearch(input);
    expect(result).toMatchObject({ sourceRows: 1, parsedRows: 1, loadedRows: 1, verifiedLoadedRows: 1 });
    const snapshot = input.persist.mock.calls[0]![1];
    expect(snapshot.assets[0]).toMatchObject({ durationSeconds: null, thumbnailUrl: null, thumbnailExpiresAt: null, usedInCampaignIds: ['synthetic-campaign'], observation: { specChecks: { approvedPrograms: null, failedSpecChecks: null } } });
    expect(Object.keys(input.reader).sort()).toEqual(['probeCreativeAssetsPage', 'probeSbAdsPage']);
    expect(input.reader.probeCreativeAssetsPage).toHaveBeenCalledOnce(); expect(input.reader.probeSbAdsPage).toHaveBeenCalledOnce();
  });
  it('replays the same job after a commit without reading Amazon again or changing observed time', async () => {
    const input = setup(); const first = await executeAssetLibrarySearch(input);
    expect(await executeAssetLibrarySearch({ ...input, now: () => '2026-06-11T00:00:00.000Z' })).toEqual(first);
    expect(input.persist).toHaveBeenCalledOnce(); expect(input.reader.probeCreativeAssetsPage).toHaveBeenCalledOnce();
  });
  it('records an empty completed snapshot distinctly from no snapshot', async () => {
    const input = setup(); input.reader.probeCreativeAssetsPage.mockResolvedValue({ ...library, items: [], sourceRows: 0, totalRecords: 0 });
    expect((await executeAssetLibrarySearch(input)).verifiedLoadedRows).toBe(0);
    expect(input.persist.mock.calls[0]![1].assets).toEqual([]);
  });
  it.each(['count', 'pagination', 'version', 'receipt'] as const)('refuses incomplete %s evidence', async (failure) => {
    const input = setup();
    if (failure === 'count') input.reader.probeCreativeAssetsPage.mockResolvedValue({ ...library, sourceRows: 2 });
    if (failure === 'pagination') input.reader.probeSbAdsPage.mockResolvedValue({ ...ads, nextToken: 'synthetic-next' });
    if (failure === 'version') input.reader.probeCreativeAssetsPage.mockResolvedValue({ ...library, items: [{ ...library.items[0]!, version: null }] });
    if (failure === 'receipt') input.persist.mockResolvedValue({ persistedRows: 0, verifiedRows: 0 });
    await expect(executeAssetLibrarySearch(input)).rejects.toThrow();
    if (failure !== 'receipt') expect(input.persist).not.toHaveBeenCalled();
  });
  it('refuses mismatched profile scope before any provider read', async () => {
    const input = setup(); await expect(executeAssetLibrarySearch({ ...input, profile: { ...profile, id: id(8) } })).rejects.toThrow('scope');
    expect(input.reader.probeSbAdsPage).not.toHaveBeenCalled();
  });
});
