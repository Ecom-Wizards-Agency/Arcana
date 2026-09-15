'use client';
import { useState } from 'react';
import type { AssetLibrarySnapshot, UsedCampaignCreative, AssetLibrarySnapshotAsset } from '@wizard-ads/shared/asset-library';
import { Button, Input, Notice } from '../campaigns/ui';

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
  return <section className="wa-stack"><h2>Pick a creative you already have</h2><p>Amazon Creative Asset Library · {snapshot ? `${snapshot.assets.length} assets` : 'No snapshot'} · no upload needed</p>
    <div className="wa-actions" role="tablist" aria-label="Creative library">{[['library','Asset Library'],['used','Used in this account'],['upload','Upload new']].map(([value,label]) => <Button key={value} role="tab" aria-selected={tab === value} disabled={value === 'upload'} title={value === 'upload' ? 'Upload is not available; reuse an asset so its Amazon ID is kept' : undefined} onClick={() => setTab(value as typeof tab)}>{label}</Button>)}</div>
    <Notice>Upload is not available; reuse an asset so its Amazon ID is kept.</Notice>
    <div className="wa-actions"><Input aria-label="Search creative assets" value={search} onChange={(event) => setSearch(event.target.value)} />{[['all','All assets'],['video','Video only'],['used','Used before'],['unused','Never used']].map(([value,label]) => <Button key={value} aria-pressed={value === filter} onClick={() => setFilter(value!)}>{label}</Button>)}</div>
    {tab === 'used' ? usedAssets.length ? usedAssets.map((asset) => <article key={asset.id}><strong>{asset.name ?? 'Unnamed creative'}</strong><p>{asset.kind} · used in {asset.usedInCampaignIds.length} campaigns · {asset.amazonAssetId ?? 'Amazon asset ID unavailable'}</p></article>) : <Notice>{used.length ? 'No mirrored creatives match these filters.' : 'No creative placements are mirrored for this profile.'}</Notice> : tab === 'upload' ? <Notice>Reuse an existing asset from the library.</Notice> : !snapshot ? <Notice>No asset-library snapshot exists yet. Refresh to read the library.</Notice> : !assets.length ? <Notice>No assets match this snapshot and filter.</Notice> : <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 16 }}>{assets.map((asset) => <article key={JSON.stringify(asset.observation.identity)} style={{ border: '1px solid var(--wa-border)', borderRadius: 'var(--wa-radius)', padding: 16 }}>
      <div style={{ height: 110, background: 'var(--wa-surface-2)', display: 'grid', placeItems: 'center' }}>{asset.thumbnailUrl && asset.thumbnailExpiresAt && Date.parse(asset.thumbnailExpiresAt) > Date.now()
        ? <img src={asset.thumbnailUrl} alt={asset.observation.name ?? 'Creative thumbnail'} style={{ maxHeight: 110, maxWidth: '100%' }} /> : <span>Thumbnail unavailable</span>}</div>
      <h3>{asset.observation.name ?? 'Unnamed asset'}</h3><p>{asset.durationSeconds === null ? 'Duration not measured' : `${asset.durationSeconds} seconds`}</p><p>{asset.usedInCampaignIds.length ? `Used in ${asset.usedInCampaignIds.length} campaigns` : 'No use observed'}</p>
      <Button aria-pressed={selected?.observation.identity.assetId === asset.observation.identity.assetId && selected.observation.identity.version === asset.observation.identity.version} onClick={() => { setSelected(asset); onSelect?.(asset); }}>Select asset</Button>
    </article>)}</div>}
    {selected && <Notice>Selected for review: {selected.observation.identity.assetId} · version {selected.observation.identity.version}. This selection is not saved as a campaign draft.</Notice>}
    <p className="wa-hint">Observed: {snapshot?.observedAt ?? 'Not measured'}. “Never used” means no use observed in the current Sponsored Brands video snapshot; historical and other-format use may be missing. Thumbnails require a known expiry. Asset reuse preserves the Amazon asset ID. Processing status does not establish moderation approval.</p>
    <Button disabled={!canRefresh || busy} onClick={async () => { setBusy(true); try { await onRefresh(); setMessage('Asset-library refresh queued. Reload after the worker finishes.'); } catch (error) { setMessage(error instanceof Error ? error.message : 'Refresh unavailable'); } finally { setBusy(false); } }}>Refresh from Amazon</Button>{message && <Notice>{message}</Notice>}
    {!canRefresh && <Notice>Asset-library refresh is unavailable until its ingestion job is registered and the operator has editing permission.</Notice>}
  </section>;
}
