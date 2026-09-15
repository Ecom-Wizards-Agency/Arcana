import { AssetLibraryObservation, AssetLibrarySnapshot, AssetLibrarySearchJob, type AssetLibrarySnapshotAsset } from '@wizard-ads/shared/asset-library';
import type { AdsProfileContext, SbVideoContractProbeClient } from './ads-api.js';

/** The injected provider exposes only reads; creation and upload cannot enter this job. */
export async function executeAssetLibrarySearch(input: {
  job: AssetLibrarySearchJob; jobId: string; profile: AdsProfileContext;
  reader: SbVideoContractProbeClient; now: () => string;
  readExisting: (orgId: string, profileId: string, jobId: string) => Promise<AssetLibrarySnapshot | null>;
  persist: (orgId: string, snapshot: AssetLibrarySnapshot) => Promise<{ persistedRows: number; verifiedRows: number }>;
}) {
  const job = AssetLibrarySearchJob.parse(input.job);
  if (job.orgId !== input.profile.orgId || job.profileId !== input.profile.id) throw new Error('Asset library job scope mismatch');
  const existing = await input.readExisting(job.orgId, job.profileId, input.jobId);
  if (existing) {
    const saved = AssetLibrarySnapshot.parse(existing);
    if (saved.id !== input.jobId || saved.profileId !== job.profileId) throw new Error('Asset library replay scope mismatch');
    return { sourceRows: saved.sourceRows, parsedRows: saved.assets.length, loadedRows: saved.persistedRows, verifiedLoadedRows: saved.assets.length, refusedRows: 0, observedAt: saved.observedAt };
  }
  const observedAt = input.now();
  const [library, ads] = await Promise.all([input.reader.probeCreativeAssetsPage(input.profile), input.reader.probeSbAdsPage(input.profile)]);
  if (library.nextToken !== null || ads.nextToken !== null || library.sourceRows !== library.items.length || ads.sourceRows !== ads.items.length
    || library.totalRecords !== null && library.totalRecords !== library.items.length || ads.totalResults !== null && ads.totalResults !== ads.items.length) throw new Error('Asset library traversal counts do not reconcile');
  const assets: AssetLibrarySnapshotAsset[] = library.items.map((asset) => {
    const processing = { ACTIVE: 'active', PROCESSING: 'processing', ARCHIVED: 'archived', INACTIVE: 'inactive' }[asset.status ?? ''] ?? 'unknown';
    const observation = AssetLibraryObservation.parse({ scope: { region: input.profile.region, amazonProfileId: input.profile.amazonProfileId },
      identity: { assetId: asset.assetId, version: asset.version }, observedAt, assetType: asset.assetType.toLowerCase() === 'video' ? 'video' : asset.assetType.toLowerCase() === 'image' ? 'image' : 'unknown', name: asset.name, processing,
      specChecks: { approvedPrograms: null, failedSpecChecks: null } });
    const usedInCampaignIds = [...new Set(ads.items.filter((ad) => ad.videoAssets.some((reference) => reference.kind === 'asset_library' && reference.assetId === asset.assetId && (reference.version === null || reference.version === asset.version))).map((ad) => ad.campaignId))].sort();
    // The current source does not establish duration or signed thumbnail expiry.
    return { observation, durationSeconds: null, thumbnailUrl: null, thumbnailExpiresAt: null, usedInCampaignIds };
  });
  const snapshot = AssetLibrarySnapshot.parse({ id: input.jobId, profileId: job.profileId, observedAt, assets, sourceRows: library.sourceRows, persistedRows: assets.length });
  const receipt = await input.persist(job.orgId, snapshot);
  if (receipt.persistedRows !== assets.length || receipt.verifiedRows !== assets.length) throw new Error('Asset library snapshot counts do not reconcile');
  return { sourceRows: library.sourceRows, parsedRows: assets.length, loadedRows: receipt.persistedRows, verifiedLoadedRows: receipt.verifiedRows, refusedRows: 0, observedAt };
}
