import { AdGroupProductAssignmentInput, AdGroupProductAssignmentScope, AdGroupProductAssignmentList } from '@wizard-ads/shared';
import type { AuthenticatedEditorTransaction, AuthenticatedReadSnapshot } from './authenticated-actor.js';
import { AgencyAccessDenied } from './authenticated-actor.js';

export async function listAdGroupProducts(context: AuthenticatedReadSnapshot | AuthenticatedEditorTransaction, raw: AdGroupProductAssignmentScope): Promise<AdGroupProductAssignmentList> {
  const scope = AdGroupProductAssignmentScope.parse(raw);
  const { sql, actor } = context;
  const profile = await sql`select id from public.ad_profiles where org_id=${actor.orgId} and id=${scope.profileId}`;
  if (profile.length !== 1) throw new AgencyAccessDenied();
  const rows = await sql<{ ad_group_id: string; campaign_id: string; name: string | null; asins: string[]; spend: string | null; assigned_asin: string | null }[]>`
    with products as (
      select p.campaign_id,p.ad_group_id,array_agg(distinct p.asin order by p.asin) as asins
      from public.product_ads p where p.org_id=${actor.orgId} and p.profile_id=${scope.profileId}
        and p.asin is not null and p.deleted_at is null
      group by p.campaign_id,p.ad_group_id having count(distinct p.asin)>1
    ), costs as (
      select campaign_id,ad_group_id,sum(cost) as spend from public.fact_sp_target_daily
      where org_id=${actor.orgId} and profile_id=${scope.profileId} and date between ${scope.start} and ${scope.end}
      group by campaign_id,ad_group_id
    ) select p.ad_group_id,p.campaign_id,g.name,p.asins,c.spend::text,
      case when a.asin=any(p.asins) then a.asin else null end as assigned_asin
    from products p join public.ad_groups g on g.org_id=${actor.orgId} and g.profile_id=${scope.profileId}
      and g.amazon_id=p.ad_group_id and g.campaign_id=p.campaign_id and g.deleted_at is null
    left join costs c on c.campaign_id=p.campaign_id and c.ad_group_id=p.ad_group_id
    left join public.ad_group_product_assignments a on a.org_id=${actor.orgId} and a.profile_id=${scope.profileId} and a.ad_group_id=p.ad_group_id
    order by c.spend desc nulls last,p.ad_group_id`;
  const items = rows.map((row) => ({ adGroupId: row.ad_group_id, campaignId: row.campaign_id, name: row.name,
    asins: row.asins, spend: row.spend === null ? null : Number(row.spend), assignedAsin: row.assigned_asin }));
  const unresolved = items.filter((item) => item.assignedAsin === null && item.spend !== null && item.spend > 0);
  const [permission] = await sql<{ allowed: boolean }[]>`select app.has_org_role(${actor.orgId},array['owner','admin','analyst']) as allowed`;
  return AdGroupProductAssignmentList.parse({ ...scope, canAssign: permission?.allowed === true,
    days: Math.round((Date.parse(scope.end)-Date.parse(scope.start))/86400000)+1,
    items, count: items.length, unassignedCount: unresolved.length,
    unassignedSpend: unresolved.reduce((sum, item) => sum + item.spend!, 0) });
}

export async function assignAdGroupProduct(context: AuthenticatedEditorTransaction, raw: AdGroupProductAssignmentInput): Promise<void> {
  const input = AdGroupProductAssignmentInput.parse(raw);
  const { sql, actor } = context;
  const rows = await sql`insert into public.ad_group_product_assignments(org_id,profile_id,ad_group_id,asin,assigned_by)
    values (${actor.orgId},${input.profileId},${input.adGroupId},${input.asin},${actor.userId})
    on conflict(org_id,profile_id,ad_group_id) do update set asin=excluded.asin,assigned_by=excluded.assigned_by
    returning ad_group_id`;
  if (rows.length !== 1) throw new Error('Assignment row count mismatch');
}
