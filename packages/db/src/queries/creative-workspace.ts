import { type NamingSettings } from '@wizard-ads/campaigns';
import {
  CreativeWorkspace, NamingStrategy, TimelineDaily, TimelineEvent,
  type CreativeWorkspaceAsset, type CreativeWorkspaceCampaign,
} from '@wizard-ads/shared';
import type { QueryHandle } from '../client.js';
import { readCreativePerformance, resolveCreativeKeyword } from './creative-performance.js';
import { readCreativeChangeHistory } from './creative-change-history.js';
import { readAssetEvidence } from './asset-evidence.js';

export interface CreativeWorkspaceFilter { orgId: string; profileId: string; from: string; to: string }

/** Tenant naming is explicit; absence never tries every installed preset. */
function namingSettings(raw: unknown): NamingSettings[] {
  const result = NamingStrategy.safeParse(raw);
  if (!result.success || !result.data.variable_order?.length || !result.data.delimiter) return [];
  return [{ variableOrder: result.data.variable_order, delimiter: result.data.delimiter,
    suffix: result.data.suffix ?? '', custom1Value: result.data.custom1_value ?? '', custom2Value: result.data.custom2_value ?? '' }];
}
const unique = (values: readonly string[]) => [...new Set(values)].sort();
const iso = (value: Date | string | null): string | null => value === null ? null : new Date(value).toISOString();
const metadataNumber = (metadata: Record<string, unknown>, key: string) => typeof metadata[key] === 'number' && Number.isFinite(metadata[key]) && metadata[key] > 0 ? metadata[key] : null;

/** Real roster and facts remain distinct; an asset without facts is unmeasured. */
export async function readCreativeWorkspace(handle: QueryHandle, filter: CreativeWorkspaceFilter): Promise<CreativeWorkspace> {
  const { orgId, profileId, from, to } = filter;
  const [profile] = await handle.sql<{ target_acos: string | number | null }[]>`
    select target_acos from public.ad_profiles where org_id=${orgId} and id=${profileId}`;
  if (!profile) throw new Error('Creative profile not found');
  const [strategy] = await handle.sql<{ naming: unknown }[]>`
    select doc->'naming' as naming from public.profile_strategy where org_id=${orgId}
      and (profile_id=${profileId} or profile_id is null) order by profile_id nulls last,updated_at desc limit 1`;
  const naming = namingSettings(strategy?.naming);
  const [performance, roster, links, campaignRows, groupRows, keywordRows, placements, history, eventRows, evidence, changes] = await Promise.all([
    readCreativePerformance(handle, filter, naming),
    handle.sql<{ asset_id: string; name: string | null; kind: string; url: string | null; first_seen_at: Date | string; metrics: Record<string, unknown> }[]>`
      select amazon_asset_id as asset_id,name,kind,url,first_seen_at,metrics from public.creative_assets
      where org_id=${orgId} and profile_id=${profileId} and amazon_asset_id is not null order by first_seen_at,amazon_asset_id`,
    handle.sql<{ asset_id: string | null; campaign_id: string; ad_group_id: string | null; ad_id: string | null; is_placement: boolean }[]>`
      select distinct a.amazon_asset_id as asset_id,p.campaign_id,p.ad_group_id,p.ad_id,true as is_placement
      from public.creative_placements p join public.creative_assets a on a.id=p.asset_id and a.org_id=p.org_id and a.profile_id=p.profile_id
      where p.org_id=${orgId} and p.profile_id=${profileId} and p.campaign_id is not null
        and (p.started_at is null or p.started_at<${to}::date+interval '1 day')
        and (p.ended_at is null or p.ended_at>=${from}::date)
      union select distinct amazon_asset_id,campaign_id,ad_group_id,ad_id,false from public.ad_creative_asset_mappings
        where org_id=${orgId} and profile_id=${profileId} and ad_product='SB'
          and observed_at>=${from}::date and observed_at<${to}::date+interval '1 day'
          and (creative_sync_snapshot_id=(select id from public.creative_sync_snapshots where org_id=${orgId} and profile_id=${profileId}
            order by observed_at desc,id desc limit 1)
            or (creative_sync_snapshot_id is null and observed_at=(select max(observed_at) from public.ad_creative_asset_mappings latest
              where latest.org_id=${orgId} and latest.profile_id=${profileId})))
      union select distinct amazon_asset_id,campaign_id,ad_group_id,ad_id,false from public.fact_creative_daily
        where org_id=${orgId} and profile_id=${profileId} and date between ${from}::date and ${to}::date`,
    handle.sql<{ campaign_id: string; name: string | null; modifiers: CreativeWorkspaceCampaign['modifiers'] | null }[]>`
      select amazon_id as campaign_id,name,placement_bidding as modifiers from public.campaigns
        where org_id=${orgId} and profile_id=${profileId} and ad_product='SB' order by amazon_id`,
    handle.sql<{ campaign_id: string; ad_group_id: string; name: string | null }[]>`
      select campaign_id,amazon_id as ad_group_id,name from public.ad_groups
        where org_id=${orgId} and profile_id=${profileId} and ad_product='SB'
          and (deleted_at is null or deleted_at>=${from}::date) order by campaign_id,amazon_id`,
    handle.sql<{ campaign_id: string; keyword_texts: string[] }[]>`
      select campaign_id,array_agg(distinct keyword_text order by keyword_text) as keyword_texts from public.keywords
        where org_id=${orgId} and profile_id=${profileId} and ad_product='SB' and deleted_at is null group by campaign_id`,
    handle.sql<{ campaignId: string; placement: string; impressions: number; clicks: number; cost: number; sales: number; purchases: number }[]>`
      select campaign_id as "campaignId",placement::text,sum(impressions)::float8 as impressions,sum(clicks)::float8 as clicks,
        sum(cost)::float8 as cost,sum(sales_7d)::float8 as sales,sum(purchases_7d)::float8 as purchases
      from public.fact_placement_daily where org_id=${orgId} and profile_id=${profileId} and ad_product='SB'
        and date between ${from}::date and ${to}::date group by campaign_id,placement order by campaign_id,placement`,
    handle.sql`select date::text,sum(cost)::float8 as spend,sum(sales_7d)::float8 as sales,sum(clicks)::float8 as clicks,
      sum(purchases_7d)::float8 as orders,sum(impressions)::float8 as impressions from public.fact_profile_daily
      where org_id=${orgId} and profile_id=${profileId} group by date order by date`,
    handle.sql`select id::text,name,'experiment'::text as kind,(start_at at time zone 'UTC')::date::text as start,
        (end_at at time zone 'UTC')::date::text as end,status::text,scope,metric_focus::text as focus,hypothesis as note,
        created_by::text as "actorId",created_at::text as "createdAt",null::text as "supersedesId"
      from public.experiments where org_id=${orgId} and profile_id=${profileId}
      union all select id::text,name,kind::text,start_on::text,end_on::text,'recorded','{}'::jsonb,'sales',note,created_by::text,created_at::text,supersedes_id::text
        from public.timeline_events e where org_id=${orgId} and profile_id=${profileId}
        and not exists(select 1 from public.timeline_events next where next.supersedes_id=e.id)
      union all select id::text,coalesce(tag,'Applied advertising changes'),'apply_batch',
        coalesce(applied_on,(applied_at at time zone 'UTC')::date)::text,coalesce(applied_on,(applied_at at time zone 'UTC')::date)::text,
        status::text,'{}'::jsonb,'acos',coalesce(note,''),created_by::text,created_at::text,null
      from public.apply_batches where org_id=${orgId} and profile_id=${profileId} and status in ('applied','reverted')
        and (applied_on is not null or applied_at is not null)`,
    handle.sql<{ min_clicks: string | number | null }[]>`select min_clicks from public.timeline_evidence_settings where org_id=${orgId} and profile_id=${profileId}`,
    readCreativeChangeHistory(handle, filter),
  ]);
  const metadataById = new Map(roster.map((asset) => [asset.asset_id, asset]));
  const assets: CreativeWorkspaceAsset[] = performance.map((fact) => {
    const asset = fact.assetId === null ? undefined : metadataById.get(fact.assetId);
    const usage = links.filter((link) => link.asset_id === fact.assetId);
    const metadata = asset?.metrics ?? {};
    return { assetId: fact.assetId, attributionState: fact.attributionState, name: fact.name, assetType: fact.assetType,
      thumbnailUrl: fact.thumbnailUrl, firstSeenAt: asset ? iso(asset.first_seen_at) : null,
      durationSeconds: metadataNumber(metadata, 'durationSeconds'), width: metadataNumber(metadata, 'width'), height: metadataNumber(metadata, 'height'),
      advertisedAsin: typeof metadata['advertisedAsin'] === 'string' && /^[A-Z0-9]{10}$/.test(metadata['advertisedAsin']) ? metadata['advertisedAsin'] : null,
      moderation: null, campaignIds: unique([...usage.map((link) => link.campaign_id), ...fact.drilldown.map((row) => row.campaignId)]),
      placementCampaignIds: unique(usage.filter((link) => fact.assetId !== null && link.is_placement).map((link) => link.campaign_id)),
      adGroupIds: unique([...usage.flatMap((link) => link.ad_group_id === null ? [] : [link.ad_group_id]), ...fact.drilldown.map((row) => row.adGroupId)]), performance: fact };
  });
  for (const asset of roster) {
    if (assets.some((row) => row.assetId === asset.asset_id)) continue;
    const usage = links.filter((link) => link.asset_id === asset.asset_id);
    assets.push({ assetId: asset.asset_id, attributionState: 'mapped', name: asset.name, assetType: asset.kind, thumbnailUrl: asset.url,
      firstSeenAt: iso(asset.first_seen_at), durationSeconds: metadataNumber(asset.metrics, 'durationSeconds'),
      width: metadataNumber(asset.metrics, 'width'), height: metadataNumber(asset.metrics, 'height'),
      advertisedAsin: typeof asset.metrics['advertisedAsin'] === 'string' && /^[A-Z0-9]{10}$/.test(asset.metrics['advertisedAsin']) ? asset.metrics['advertisedAsin'] : null,
      moderation: null, campaignIds: unique(usage.map((link) => link.campaign_id)),
      placementCampaignIds: unique(usage.filter((link) => link.is_placement).map((link) => link.campaign_id)),
      adGroupIds: unique(usage.flatMap((link) => link.ad_group_id === null ? [] : [link.ad_group_id])), performance: null });
  }
  if (assets.length !== performance.length + roster.filter((asset) => !performance.some((row) => row.assetId === asset.asset_id)).length)
    throw new Error('Creative asset roster count mismatch');
  const campaigns = unique([...campaignRows.map((row) => row.campaign_id), ...links.map((row) => row.campaign_id)]).map((campaignId) => {
    const row = campaignRows.find((item) => item.campaign_id === campaignId);
    const keywords = keywordRows.find((item) => item.campaign_id === campaignId)?.keyword_texts ?? [];
    const keyword = resolveCreativeKeyword(keywords, row?.name ?? null, naming);
    const campaignLinks = links.filter((link) => link.campaign_id === campaignId);
    const adGroups = unique([...groupRows.filter((group) => group.campaign_id === campaignId).map((group) => group.ad_group_id),
      ...campaignLinks.flatMap((link) => link.ad_group_id === null ? [] : [link.ad_group_id])]).map((adGroupId) => ({
      adGroupId, name: groupRows.find((group) => group.campaign_id === campaignId && group.ad_group_id === adGroupId)?.name ?? null,
      assetIds: unique(campaignLinks.filter((link) => link.ad_group_id === adGroupId).flatMap((link) => link.asset_id === null ? [] : [link.asset_id])),
      unmappedCount: new Set(campaignLinks.filter((link) => link.ad_group_id === adGroupId && link.asset_id === null).map((link) => link.ad_id)).size,
    }));
    return { campaignId, name: row?.name ?? null, ...keyword,
      // A parsed name resolves text, but cannot prove the entity count.
      keywordCount: keywords.length ? keywords.length : null,
      adGroups, modifiers: { topOfSearch: row?.modifiers?.topOfSearch ?? null, restOfSearch: row?.modifiers?.restOfSearch ?? null, productPages: row?.modifiers?.productPages ?? null } };
  });
  // Facts may name a missing roster asset; retain it instead of losing the test row.
  for (const assetId of unique(links.flatMap((link) => link.asset_id === null ? [] : [link.asset_id]))) {
    if (assets.some((asset) => asset.assetId === assetId)) continue;
    const usage = links.filter((link) => link.asset_id === assetId);
    assets.push({ assetId, attributionState: 'mapped', name: null, assetType: null, thumbnailUrl: null, firstSeenAt: null,
      durationSeconds: null, width: null, height: null, advertisedAsin: null, moderation: null,
      placementCampaignIds: unique(usage.filter((link) => link.is_placement).map((link) => link.campaign_id)),
      campaignIds: unique(usage.map((link) => link.campaign_id)), adGroupIds: unique(usage.flatMap((link) => link.ad_group_id === null ? [] : [link.ad_group_id])), performance: null });
  }
  const assetEvidence = await readAssetEvidence(handle, { orgId, profileId, now: new Date().toISOString() });
  for (const observation of assetEvidence.assets) {
    if (!assets.some((row) => row.assetId === observation.identity.assetId)) assets.push({
      assetId: observation.identity.assetId, attributionState: 'mapped', name: observation.name, assetType: observation.assetType,
      thumbnailUrl: null, firstSeenAt: observation.observedAt, durationSeconds: observation.mediaMetadata?.durationSeconds ?? null,
      width: observation.mediaMetadata?.width ?? null, height: observation.mediaMetadata?.height ?? null, advertisedAsin: null,
      moderation: null, campaignIds: [], adGroupIds: [], placementCampaignIds: [], performance: null,
    });
  }
  for (const asset of assets) {
    asset.assetLibrary = assetEvidence.assets.filter((row) => row.identity.assetId === asset.assetId);
    asset.assetLibraryEvidence = assetEvidence.assetObservations.filter((row) => row.observation.identity.assetId === asset.assetId);
    asset.moderationEvidence = assetEvidence.moderationObservations.filter((row) => row.observation.assetIdentity?.assetId === asset.assetId);
    const metadata = asset.assetLibrary.length === 1 ? asset.assetLibrary[0] : undefined;
    if (metadata) {
      asset.width = metadata.mediaMetadata?.width ?? asset.width;
      asset.height = metadata.mediaMetadata?.height ?? asset.height;
      asset.durationSeconds = metadata.mediaMetadata?.durationSeconds ?? asset.durationSeconds;
    }
  }
  return CreativeWorkspace.parse({ assets, campaigns, changes,
    placements: placements.map((row) => {
      const modifiers = campaigns.find((campaign) => campaign.campaignId === row.campaignId)?.modifiers;
      return { ...row, modifier: row.placement === 'top_of_search' ? modifiers?.topOfSearch ?? null
        : row.placement === 'rest_of_search' ? modifiers?.restOfSearch ?? null : row.placement === 'product_pages' ? modifiers?.productPages ?? null : null };
    }),
    history: history.map((row) => TimelineDaily.parse(row)), events: eventRows.map((row) => TimelineEvent.parse({ ...row, scopeText: 'Account calibration event' })),
    minClicks: evidence[0]?.min_clicks == null ? null : Number(evidence[0].min_clicks),
    targetAcos: profile.target_acos === null ? null : Number(profile.target_acos),
  });
}
