import { readListingChanges } from './own-collectors.js';
import { CreativeWorkspaceChange, type CreativeChangeCertainty } from '@wizard-ads/shared';
import type { QueryHandle } from '../client.js';

/** Saved certainty is returned verbatim; a later sync cannot move an old event. */
export async function readCreativeChangeHistory(handle: QueryHandle, filter: {
  orgId: string; profileId: string; from: string; to: string;
}): Promise<CreativeWorkspaceChange[]> {
  const { orgId, profileId, from, to } = filter;
  const rows = await handle.sql<{
    id: string; asset_ids: string[]; campaign_id: string | null; ad_group_id: string | null;
    kind: 'Bid' | 'Placement'; field: string; old_value: unknown; new_value: unknown;
    observed_at: Date | string; certainty: CreativeChangeCertainty;
  }[]>`
    with usage as (
      select distinct a.amazon_asset_id as asset_id,p.campaign_id,p.ad_group_id
      from public.creative_placements p join public.creative_assets a on a.id=p.asset_id and a.org_id=p.org_id and a.profile_id=p.profile_id
      where p.org_id=${orgId} and p.profile_id=${profileId} and a.amazon_asset_id is not null
        and (p.started_at is null or p.started_at<${to}::date+interval '1 day')
        and (p.ended_at is null or p.ended_at>=${from}::date)
      union select distinct amazon_asset_id,campaign_id,ad_group_id from public.ad_creative_asset_mappings
        where org_id=${orgId} and profile_id=${profileId} and amazon_asset_id is not null
          and observed_at>=${from}::date and observed_at<${to}::date+interval '1 day'
          and (creative_sync_snapshot_id=(select id from public.creative_sync_snapshots where org_id=${orgId} and profile_id=${profileId}
            order by observed_at desc,id desc limit 1)
            or (creative_sync_snapshot_id is null and observed_at=(select max(observed_at) from public.ad_creative_asset_mappings latest
              where latest.org_id=${orgId} and latest.profile_id=${profileId})))
      union select distinct amazon_asset_id,campaign_id,ad_group_id from public.fact_creative_daily
        where org_id=${orgId} and profile_id=${profileId} and amazon_asset_id is not null
          and date between ${from}::date and ${to}::date
    ), scoped as (
      select ec.*,case when ec.entity_type='campaign' then ec.amazon_id else coalesce(g.campaign_id,k.campaign_id,t.campaign_id) end as campaign_id,
        case when ec.entity_type='ad_group' then ec.amazon_id else coalesce(k.ad_group_id,t.ad_group_id) end as ad_group_id
      from public.entity_changes ec
      left join public.ad_groups g on ec.entity_type='ad_group' and g.amazon_id=ec.amazon_id and g.org_id=ec.org_id and g.profile_id=ec.profile_id
      left join public.keywords k on ec.entity_type='keyword' and k.amazon_id=ec.amazon_id and k.org_id=ec.org_id and k.profile_id=ec.profile_id
      left join public.targets t on ec.entity_type='target' and t.amazon_id=ec.amazon_id and t.org_id=ec.org_id and t.profile_id=ec.profile_id
      where ec.org_id=${orgId} and ec.profile_id=${profileId} and ec.field in ('bid','defaultBid','placementBidding')
        and ec.observed_at>=${from}::date and ec.observed_at<${to}::date+interval '1 day'
    )
    select ec.id::text,array_agg(distinct u.asset_id order by u.asset_id) as asset_ids,ec.campaign_id,ec.ad_group_id,
      case when ec.field='placementBidding' then 'Placement' else 'Bid' end as kind,
      ec.field,ec.old_value,ec.new_value,ec.observed_at,ec.certainty
    from scoped ec join usage u on u.campaign_id=ec.campaign_id and (ec.ad_group_id is null or u.ad_group_id=ec.ad_group_id)
    group by ec.id,ec.campaign_id,ec.ad_group_id,ec.field,ec.old_value,ec.new_value,ec.observed_at,ec.certainty order by ec.observed_at desc,ec.id desc`;
  const first = await handle.sql<{ id: string; asset_id: string; campaign_id: string | null; ad_group_id: string | null; started_at: Date | string }[]>`
    select p.id::text,a.amazon_asset_id as asset_id,p.campaign_id,p.ad_group_id,p.started_at
    from public.creative_placements p join public.creative_assets a on a.id=p.asset_id and a.org_id=p.org_id and a.profile_id=p.profile_id
    where p.org_id=${orgId} and p.profile_id=${profileId} and a.amazon_asset_id is not null
      and p.started_at>=${from}::date and p.started_at<${to}::date+interval '1 day' order by p.started_at desc,p.id`;
  const listing = await readListingChanges(handle,filter);
  const listingRows: CreativeWorkspaceChange[] = [];
  for (const change of listing) {
    const usages = await handle.sql<{ asset_ids: string[]; campaign_id: string; ad_group_id: string }[]>`select array_agg(distinct a.amazon_asset_id) as asset_ids,p.campaign_id,p.ad_group_id
      from public.product_ads p join public.creative_placements cp on cp.org_id=p.org_id and cp.profile_id=p.profile_id and cp.campaign_id=p.campaign_id and cp.ad_group_id=p.ad_group_id
      join public.creative_assets a on a.org_id=cp.org_id and a.profile_id=cp.profile_id and a.id=cp.asset_id
      where p.org_id=${orgId} and p.profile_id=${profileId} and p.asin=${change.asin} and p.deleted_at is null and a.amazon_asset_id is not null
      and (cp.started_at is null or cp.started_at<=${change.current.provenance.observedAt})
      and (cp.ended_at is null or cp.ended_at>${change.current.provenance.observedAt})
      group by p.campaign_id,p.ad_group_id`;
    for (const usage of usages) listingRows.push(CreativeWorkspaceChange.parse({ id:`listing:${change.id}:${usage.campaign_id}:${usage.ad_group_id}`,
      assetIds:usage.asset_ids,campaignId:usage.campaign_id,adGroupId:usage.ad_group_id,kind:['coupon','lightningDeal'].includes(change.current.field) ? 'Promotion':'Listing',
      field:change.current.field,oldValue:change.previous?.value ?? null,newValue:change.current.value,observedAt:change.current.provenance.observedAt,
      certainty:change.certainty,scope:change.asin,effect:'direct' }));
  }
  const result = [...listingRows, ...rows.map((row) => CreativeWorkspaceChange.parse({
    id: `change:${row.id}`, assetIds: row.asset_ids, campaignId: row.campaign_id, adGroupId: row.ad_group_id,
    kind: row.kind, field: row.field, oldValue: row.old_value, newValue: row.new_value,
    observedAt: new Date(row.observed_at).toISOString(), certainty: row.certainty,
    scope: row.ad_group_id ?? row.campaign_id ?? 'Recorded scope', effect: row.ad_group_id === null ? 'whole campaign' : 'direct',
  })), ...first.map((row) => {
    const observedAt = new Date(row.started_at).toISOString();
    return CreativeWorkspaceChange.parse({ id: `placement:${row.id}`, assetIds: [row.asset_id], campaignId: row.campaign_id, adGroupId: row.ad_group_id,
      kind: 'Creative', field: 'firstSeen', oldValue: null, newValue: row.asset_id, observedAt,
      certainty: { kind: 'first', from: null, to: observedAt, widthDays: null },
      scope: row.ad_group_id ?? row.campaign_id ?? 'Recorded placement', effect: 'direct' });
  })].sort((a, b) => b.observedAt.localeCompare(a.observedAt) || b.id.localeCompare(a.id));
  if (result.length !== rows.length + first.length + listingRows.length) throw new Error('Creative history count mismatch');
  return result;
}
