import { Uuid } from '@wizard-ads/shared';
import { AssetLibrarySnapshot, AssetLibrarySnapshotAsset, UsedCampaignCreative } from '@wizard-ads/shared/asset-library';
import type { DbHandle, QueryHandle } from '../client.js';
import type { AuthenticatedReadSnapshot } from './authenticated-actor.js';

async function readSnapshot(handle: QueryHandle, orgId: string, profileId: string, id: string | null): Promise<AssetLibrarySnapshot | null> {
  const headers = await handle.sql<{ id: string; observedAt: string; sourceRows: number; persistedRows: number }[]>`
    select id,to_char(observed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "observedAt",source_rows as "sourceRows",persisted_rows as "persistedRows"
    from public.asset_library_snapshots where org_id=${orgId}::uuid and profile_id=${profileId}::uuid
      and (${id}::uuid is null or id=${id}::uuid) order by observed_at desc,id limit 1`;
  if (!headers.length) return null;
  const header = headers[0]!;
  const rows = await handle.sql`select observation,duration_seconds::float8 as "durationSeconds",thumbnail_url as "thumbnailUrl",
    case when thumbnail_expires_at is null then null else to_char(thumbnail_expires_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end as "thumbnailExpiresAt",used_in_campaign_ids as "usedInCampaignIds"
    from public.asset_library_assets where org_id=${orgId}::uuid and profile_id=${profileId}::uuid and snapshot_id=${header.id}::uuid order by amazon_asset_id,version`;
  return AssetLibrarySnapshot.parse({ ...header, profileId, assets: rows.map((row) => AssetLibrarySnapshotAsset.parse(row)) });
}
export async function readAssetLibrarySnapshot(context: AuthenticatedReadSnapshot, profileId: string): Promise<AssetLibrarySnapshot | null> {
  Uuid.parse(profileId);
  return readSnapshot({ sql: context.sql }, context.actor.orgId, profileId, null);
}
/** A completed ingestion job reuses its own immutable observation on queue replay. */
export async function readAssetLibraryJobSnapshot(handle: QueryHandle, orgId: string, profileId: string, jobId: string): Promise<AssetLibrarySnapshot | null> {
  Uuid.parse(orgId); Uuid.parse(profileId); Uuid.parse(jobId);
  return readSnapshot(handle, orgId, profileId, jobId);
}
export async function listUsedCampaignCreatives(context: AuthenticatedReadSnapshot, profileId: string): Promise<UsedCampaignCreative[]> {
  Uuid.parse(profileId);
  const rows = await context.sql`select a.id,a.amazon_asset_id as "amazonAssetId",a.name,a.kind,
    coalesce(array_agg(distinct p.campaign_id order by p.campaign_id) filter(where p.campaign_id is not null),'{}') as "usedInCampaignIds"
    from public.creative_assets a join public.creative_placements p on p.org_id=a.org_id and p.profile_id=a.profile_id and p.asset_id=a.id
    where a.org_id=${context.actor.orgId}::uuid and a.profile_id=${profileId}::uuid group by a.id order by a.name,a.id`;
  return rows.map((row) => UsedCampaignCreative.parse(row));
}

/** Worker-only persistence. Atomic rows plus a header; replay cannot replace an observation. */
export async function recordAssetLibrarySnapshot(handle: Pick<DbHandle, 'sql'>, orgId: string, raw: AssetLibrarySnapshot): Promise<{ persistedRows: number; verifiedRows: number }> {
  Uuid.parse(orgId); const snapshot = AssetLibrarySnapshot.parse(raw);
  const result = await handle.sql.begin(async (sql) => {
    const profiles = await sql<{ region: string; amazon_profile_id: string }[]>`select region,amazon_profile_id from public.ad_profiles where org_id=${orgId}::uuid and id=${snapshot.profileId}::uuid for update`;
    if (profiles.length !== 1 || snapshot.assets.some((asset) => asset.observation.scope.region !== profiles[0]!.region || asset.observation.scope.amazonProfileId !== profiles[0]!.amazon_profile_id)) throw new Error('Asset snapshot profile scope mismatch');
    const existing = await readSnapshot({ sql }, orgId, snapshot.profileId, snapshot.id);
    if (existing !== null) {
      const identity = (value: AssetLibrarySnapshot) => JSON.stringify({ ...value, observedAt: new Date(value.observedAt).toISOString(), assets: [...value.assets].map((asset) => ({ ...asset, thumbnailExpiresAt: asset.thumbnailExpiresAt === null ? null : new Date(asset.thumbnailExpiresAt).toISOString() })).sort((a,b) => JSON.stringify(a.observation.identity).localeCompare(JSON.stringify(b.observation.identity))) });
      if (identity(existing) !== identity(snapshot)) throw new Error('Asset snapshot replay differs');
      return { receipt: { persistedRows: existing.persistedRows, verifiedRows: existing.assets.length } };
    }
    const headers = await sql`insert into public.asset_library_snapshots(id,org_id,profile_id,observed_at,source_rows,persisted_rows)
      values (${snapshot.id}::uuid,${orgId}::uuid,${snapshot.profileId}::uuid,${snapshot.observedAt},${snapshot.sourceRows},${snapshot.persistedRows}) returning id`;
    if (headers.length !== 1) throw new Error('Asset snapshot header count mismatch');
    let persisted = 0;
    for (const asset of snapshot.assets) {
      const observation = asset.observation;
      const rows = await sql`insert into public.asset_library_assets(org_id,profile_id,snapshot_id,amazon_asset_id,version,kind,name,duration_seconds,thumbnail_url,thumbnail_expires_at,used_in_campaign_ids,observation,observed_at)
        values (${orgId}::uuid,${snapshot.profileId}::uuid,${snapshot.id}::uuid,${observation.identity.assetId},${observation.identity.version},${observation.assetType},${observation.name},${asset.durationSeconds},${asset.thumbnailUrl},${asset.thumbnailExpiresAt},${asset.usedInCampaignIds},${JSON.stringify(observation)}::text::jsonb,${observation.observedAt}) returning amazon_asset_id`;
      if (rows.length !== 1) throw new Error('Asset snapshot row count mismatch'); persisted++;
    }
    const readback = await readSnapshot({ sql }, orgId, snapshot.profileId, snapshot.id);
    if (persisted !== snapshot.assets.length || readback?.assets.length !== persisted) throw new Error('Asset snapshot counts do not reconcile');
    return { receipt: { persistedRows: persisted, verifiedRows: readback.assets.length } };
  });
  return result.receipt;
}
