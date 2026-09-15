'use client';
import { useState } from 'react';
import type { AssetLibrarySnapshot, UsedCampaignCreative, AssetLibrarySnapshotAsset } from '@wizard-ads/shared/asset-library';
import { formatShellTimestamp } from '../../ui/date-format';
import { Button, Input, Notice, quantity } from '../campaigns/ui';

export function AssetPicker({ snapshot, used, canRefresh, onRefresh, initialTab = 'library', onSelect }: {
  snapshot: AssetLibrarySnapshot | null; used: UsedCampaignCreative[]; canRefresh: boolean; onRefresh: () => Promise<void>;
  initialTab?: 'library' | 'used' | 'upload'; onSelect?: (asset: AssetLibrarySnapshotAsset) => void;
}) {
  const [tab, setTab] = useState(initialTab); const [filter, setFilter] = useState('all'); const [search, setSearch] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<AssetLibrarySnapshotAsset | null>(null);
  const assets = snapshot?.assets.filter((asset) => (asset.observation.name ?? asset.observation.identity.assetId).toLowerCase().includes(search.toLowerCase())
    && (filter === 'video' ? asset.observation.assetType === 'video' : filter === 'used' ? asset.usedInCampaignIds.length > 0 : filter === 'unused' ? asset.usedInCampaignIds.length === 0 : true)) ?? [];
  const usedAssets = used.filter((asset) => (asset.name ?? asset.amazonAssetId ?? '').toLowerCase().includes(search.toLowerCase())
    && (filter === 'video' ? ['video', 'sb_video'].includes(asset.kind) : filter === 'unused' ? asset.usedInCampaignIds.length === 0 : true));
  function thumbnail(asset?: AssetLibrarySnapshotAsset) {
    return <div className="campaign-asset-thumbnail">{asset?.thumbnailUrl && asset.thumbnailExpiresAt && Date.parse(asset.thumbnailExpiresAt) > Date.now()
      ? <img src={asset.thumbnailUrl} alt={asset.observation.name ?? 'Creative thumbnail'} /> : <span>Thumbnail unavailable</span>}</div>;
  }
  function duration(asset?: AssetLibrarySnapshotAsset) { return asset?.durationSeconds == null ? 'Duration not measured' : `${asset.durationSeconds} seconds`; }
  function usage(count: number) { return count ? `Used in ${quantity(count, 'campaign')}` : 'No use observed'; }
  return <section className="wa-stack" aria-label="Creative asset picker"><p className="wa-hint">Sponsored Brands video · Amazon Creative Asset Library · {snapshot ? quantity(snapshot.assets.length, 'asset') : 'No snapshot'} · no upload needed</p>
    <div className="campaign-asset-toolbar"><div className="wa-actions" role="tablist" aria-label="Creative library">{[['library','Asset Library'],['used','Used in this account'],['upload','Upload new']].map(([value,label]) => <Button key={value} role="tab" aria-selected={tab === value} disabled={value === 'upload'} title={value === 'upload' ? 'Upload is not available; reuse an asset so its Amazon ID is kept' : undefined} onClick={() => setTab(value as typeof tab)}>{label}</Button>)}</div>
      <div className="wa-actions" aria-label="Creative filters">{[['all','All assets'],['video','Video only'],['used','Used before'],['unused','Never used']].map(([value,label]) => <Button className="campaign-filter" key={value} aria-pressed={value === filter} onClick={() => setFilter(value!)}>{label}</Button>)}</div></div>
    <label>Search creative assets<Input aria-label="Search creative assets" placeholder="Search by asset name" style={{ maxWidth: 360 }} value={search} onChange={(event) => setSearch(event.target.value)} /></label>
    {tab === 'used' ? usedAssets.length ? <div className="campaign-asset-grid">{usedAssets.map((asset) => {
      const observations = snapshot?.assets.filter((item) => item.observation.identity.assetId === asset.amazonAssetId) ?? [];
      const observation = observations.length === 1 ? observations[0] : undefined;
      return <article className="campaign-asset-card" key={asset.id}>{thumbnail(observation)}<h3>{asset.name ?? 'Unnamed creative'}</h3><p className="wa-hint">{duration(observation)} · {usage(asset.usedInCampaignIds.length)}</p><p className="wa-hint">{['video', 'sb_video'].includes(asset.kind) ? 'Video asset' : asset.kind === 'image' ? 'Image asset' : 'Creative asset'} · {asset.amazonAssetId ?? 'Amazon asset ID unavailable'}</p></article>;
    })}</div> : <Notice>{used.length ? 'No mirrored creatives match these filters.' : 'No creative placements are mirrored for this profile.'}</Notice> : tab === 'upload' ? <Notice>Upload is not available; reuse an asset so its Amazon ID is kept. Choose Asset Library or Used in this account.</Notice> : !snapshot ? <Notice>No asset-library snapshot exists yet. Refresh from Amazon to read this profile’s library.</Notice> : !assets.length ? <Notice>{snapshot.assets.length ? 'No assets match this snapshot and filter. Clear the search or choose All assets.' : 'No assets match this snapshot. The latest library read returned no assets. Refresh to check again.'}</Notice> : <div className="campaign-asset-grid">{assets.map((asset) => <article className="campaign-asset-card" key={JSON.stringify(asset.observation.identity)}>
      {thumbnail(asset)}<h3>{asset.observation.name ?? 'Unnamed asset'}</h3><p className="wa-hint">{duration(asset)} · {usage(asset.usedInCampaignIds.length)}</p>
      <Button aria-pressed={selected?.observation.identity.assetId === asset.observation.identity.assetId && selected.observation.identity.version === asset.observation.identity.version} onClick={() => { setSelected(asset); onSelect?.(asset); }}>Select asset</Button>
    </article>)}</div>}
    {tab !== 'upload' && <p className="wa-hint">Upload is not available; reuse an asset so its Amazon ID is kept.</p>}
    {selected && <Notice>Selected for review: {selected.observation.identity.assetId} · version {selected.observation.identity.version}. This selection is not saved as a campaign draft.</Notice>}
    <p className="wa-hint">Observed: {snapshot ? formatShellTimestamp(snapshot.observedAt) : 'Not measured'}. “Never used” means no use observed in the current Sponsored Brands video snapshot; historical and other-format use may be missing. Thumbnails require a known expiry. Asset reuse preserves the Amazon asset ID. Processing status does not establish moderation approval.</p>
    <Button disabled={!canRefresh || busy} onClick={async () => { setBusy(true); try { await onRefresh(); setMessage('Asset-library refresh queued. Reload after the worker finishes.'); } catch (error) { setMessage(error instanceof Error ? error.message : 'Refresh unavailable'); } finally { setBusy(false); } }}>Refresh from Amazon</Button>{message && <Notice>{message}</Notice>}
    {!canRefresh && <Notice>Editing permission is required to refresh the asset library.</Notice>}
  </section>;
}
