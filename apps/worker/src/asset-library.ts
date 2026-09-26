import type { IngestionRegistry } from './ingestion-registry.js';
import { persistAssetLibraryEvidence, readAssetLibraryJobSnapshot, recordAssetLibrarySnapshot, type DbHandle } from '@wizard-ads/db';
import { ingestionSource } from './ingestion-sources.js';
import { AssetLibraryObservation, AssetLibrarySnapshot, AssetLibrarySearchJob, type AssetLibrarySnapshotAsset } from '@wizard-ads/shared/asset-library';
import type { AdsProfileContext, SbVideoContractProbeClient } from './ads-api.js';

/** The injected provider exposes only reads; creation and upload cannot enter this job. */
export async function executeAssetLibrarySearch(input: {
  job: AssetLibrarySearchJob; jobId: string; profile: AdsProfileContext;
  reader: SbVideoContractProbeClient; now: () => string;
  readExisting: (orgId: string, profileId: string, jobId: string) => Promise<AssetLibrarySnapshot | null>;
  persistEvidence?: (orgId: string, snapshot: AssetLibrarySnapshot) => Promise<void>;
  persist: (orgId: string, snapshot: AssetLibrarySnapshot) => Promise<{ persistedRows: number; verifiedRows: number }>;
}) {
  const job = AssetLibrarySearchJob.parse(input.job);
  if (job.orgId !== input.profile.orgId || job.profileId !== input.profile.id) throw new Error('Asset library job scope mismatch');
  const existing = await input.readExisting(job.orgId, job.profileId, input.jobId);
  if (existing) {
    const saved = AssetLibrarySnapshot.parse(existing);
    if (saved.id !== input.jobId || saved.profileId !== job.profileId) throw new Error('Asset library replay scope mismatch');
    await input.persistEvidence?.(job.orgId,saved);
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
  await input.persistEvidence?.(job.orgId,snapshot);
  return { sourceRows: library.sourceRows, parsedRows: assets.length, loadedRows: receipt.persistedRows, verifiedLoadedRows: receipt.verifiedRows, refusedRows: 0, observedAt };
}

/** Production registry binding: the provider surface contains only reads. */
export function registerAssetLibrarySource(
  registry: Pick<IngestionRegistry, 'register'>,
  handle: Pick<DbHandle, 'sql'>,
  reader: SbVideoContractProbeClient,
  now: () => string = () => new Date().toISOString(),
): void {
  registry.register({
    source: { ...ingestionSource('asset-library.search'), jobType: 'asset-library.search', reportType: 'asset_library_assets' },
    plan: (context) => context,
    execute: ({ payload, job, profile }) => executeAssetLibrarySearch({ job: payload, jobId: job.id, profile, reader, now,
      readExisting: (orgId, profileId, jobId) => readAssetLibraryJobSnapshot(handle, orgId, profileId, jobId),
      persistEvidence: async (orgId,snapshot) => {
        const receipt=await persistAssetLibraryEvidence(handle,{orgId,profileId:snapshot.profileId},snapshot.assets.map(asset=>({
          observation:asset.observation,expiresAt:new Date(Date.parse(asset.observation.observedAt)+95*86400000).toISOString(),
        })));
        if(receipt.source!==snapshot.assets.length || receipt.verified!==receipt.canonical) throw new Error('Asset evidence readback mismatch');
      },
      persist: (orgId, snapshot) => recordAssetLibrarySnapshot(handle, orgId, snapshot),
    }),
    counts: (result) => result,
    coverage: { target: (result, context) => {
      const date = new Intl.DateTimeFormat('en-CA', { timeZone: context.profile.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(result.observedAt));
      return { reportType: 'asset_library_assets', grain: 'asset_library_assets', earliestDate: date, coveredThrough: date,
        observedAt: result.observedAt, settledThrough: null, status: 'complete' };
    } },
  });
}
