import { ProductAssignmentDerivation, ProductAssignmentEvidence, ProductAssignmentList, ProductAssignmentMutation, ProductAssignmentScope, unresolvedProductAssignment, type ProductAssignmentRefusal } from '@wizard-ads/shared';
import type { DbHandle, QueryHandle } from '../client.js';
import type { AuthenticatedEditorTransaction, AuthenticatedReadSnapshot } from './authenticated-actor.js';
import { AgencyAccessDenied } from './authenticated-actor.js';

type Scope = { orgId: string; profileId: string };
/** Calendar days the spend ranking looks back over, ending at the maturity cutoff. */
export const PRODUCT_SPEND_WINDOW_DAYS = 30;

/** A mutation the current assignment does not allow; nothing was written. */
export class ProductAssignmentRefused extends Error {
  constructor(readonly code: ProductAssignmentRefusal) {
    super('Arcana derived this ad group\'s product from its only advertised product or shared parent.');
    this.name = 'ProductAssignmentRefused';
  }
}

/**
 * Mature report days, by date rather than by when they were observed: every day
 * on or before the settled date (else local today minus 7) inside the window,
 * whose latest counted observation reconciles with the fact rows it loaded.
 */
function matureProductDays(handle: QueryHandle, scope: Scope, now: string) {
  const { sql } = handle;
  return sql`
    bounds as (
      select ((${now}::timestamptz at time zone p.timezone)::date) as today from public.ad_profiles p where p.org_id=${scope.orgId} and p.id=${scope.profileId}
    ), settled as (
      select max(c.latest_settled_date) as through from public.report_coverage c
      where c.org_id=${scope.orgId} and c.profile_id=${scope.profileId} and c.report_type='spAdvertisedProduct'
        and c.grain='advertised_product:DAILY:legacy:v1' and c.source='amazon_reporting_v3'
    ), reporting_window as (
      select least(coalesce(s.through,b.today-7),b.today-1) as finish from bounds b cross join settled s
    ), days as (
      select generate_series(finish-${PRODUCT_SPEND_WINDOW_DAYS - 1}::int,finish,interval '1 day')::date as date from reporting_window
    ), verified as (
      select d.date from days d join public.report_family_watermarks w on w.org_id=${scope.orgId} and w.profile_id=${scope.profileId}
        and w.family='spAdvertisedProduct' and w.variant='DAILY:legacy:v1' and w.period_start=d.date and w.period_end=d.date
      where w.observed_at<=${now}::timestamptz
        and w.canonical_rows=(select count(*) from public.fact_advertised_product_daily f where f.org_id=w.org_id and f.profile_id=w.profile_id
          and f.family=w.family and f.variant=w.variant and f.date=d.date and f.period_end=d.date and f.report_request_id=w.report_request_id)
    )`;
}

/** Caller holds the refresh transaction so evidence and its derived rows share a snapshot. */
export async function readProductAssignmentEvidence(handle: QueryHandle, scope: Scope, now: string): Promise<ProductAssignmentEvidence[]> {
  const { sql } = handle;
  const groups = await sql<{ id: string }[]>`select amazon_id as id from public.ad_groups where org_id=${scope.orgId} and profile_id=${scope.profileId} and ad_product='SP' and deleted_at is null order by amazon_id`;
  const ads = await sql<{ ad_group_id: string; asin: string | null; sku: string | null; state: 'enabled' | 'paused' | 'archived'; parent_asin: string | null }[]>`
    with parents as (
      select f.payload->>'asin' as asin,f.payload->>'parentAsin' as parent_asin,
        dense_rank() over (partition by f.payload->>'asin' order by f.observed_at desc,f.date desc) as recency
      from public.fact_retail_sales_traffic_daily f
      join public.spapi_profile_bindings b on b.org_id=f.org_id and b.profile_id=${scope.profileId} and b.marketplace_id=f.marketplace_id and b.enabled
      join public.spapi_connections c on c.org_id=b.org_id and c.id=b.connection_id and c.selling_partner_id=f.selling_partner_id and c.status='active'
      where f.org_id=${scope.orgId} and f.grain='child' and f.observed_at<=${now}::timestamptz
    ), latest as (
      select asin,case when count(*)=count(parent_asin) and count(distinct parent_asin)=1 then min(parent_asin) end as parent_asin
      from parents where recency=1 group by asin
    ) select p.ad_group_id,p.asin,p.sku,p.state,l.parent_asin from public.product_ads p left join latest l on l.asin=p.asin
      where p.org_id=${scope.orgId} and p.profile_id=${scope.profileId} and p.ad_product='SP' and p.deleted_at is null`;
  const [mature] = await sql<{ days: number }[]>`with ${matureProductDays(handle, scope, now)} select count(*)::int as days from verified`;
  const matureDays = mature?.days ?? 0;
  // A counted day without a product's rows is measured zero; a null cost leaves the product unmeasured.
  const spend = matureDays === 0 ? [] : await sql<{ ad_group_id: string; asin: string; spend: string }[]>`
    with ${matureProductDays(handle, scope, now)}, costs as (
      select f.dimensions->>'adGroupId' as ad_group_id,f.dimensions->>'advertisedAsin' as asin,
        case when count(*)=count(f.row_data->'metrics'->>'cost') then sum((f.row_data->'metrics'->>'cost')::numeric) end as spend
      from public.fact_advertised_product_daily f join verified v on v.date=f.date
      where f.org_id=${scope.orgId} and f.profile_id=${scope.profileId} and f.family='spAdvertisedProduct' and f.variant='DAILY:legacy:v1' and f.period_end=f.date
      group by f.dimensions->>'adGroupId',f.dimensions->>'advertisedAsin'
    ), products as (
      select distinct ad_group_id,asin from public.product_ads where org_id=${scope.orgId} and profile_id=${scope.profileId}
        and ad_product='SP' and deleted_at is null and state in ('enabled','paused') and asin is not null
    ) select p.ad_group_id,p.asin,case when c.asin is null then '0' else c.spend::text end as spend
      from products p left join costs c on c.ad_group_id=p.ad_group_id and c.asin=p.asin
      where c.asin is null or c.spend is not null`;
  return groups.map((group) => ProductAssignmentEvidence.parse({adGroupId:group.id,
    ads:ads.filter((ad) => ad.ad_group_id===group.id).map((ad) => ({asin:ad.asin,sku:ad.sku,state:ad.state,parentAsin:ad.parent_asin})),
    spend:spend.filter((row) => row.ad_group_id===group.id && row.asin !== null).map((row) => ({asin:row.asin,spend:Number(row.spend)})),
    matureDays, windowDays: PRODUCT_SPEND_WINDOW_DAYS,
  }));
}

export async function persistProductAssignments(handle: QueryHandle, scope: Scope, raw: readonly ProductAssignmentDerivation[], derivedAt: string) {
  const results = raw.map((row) => ProductAssignmentDerivation.parse(row));
  if (new Set(results.map((row) => row.adGroupId)).size !== results.length) throw new Error('Duplicate assignment groups');
  let changed = 0;
  for (const row of results) {
    const written = await handle.sql`insert into public.ad_group_product_assignments(org_id,profile_id,ad_group_id,asin,source,derivation,derived_at)
      values(${scope.orgId},${scope.profileId},${row.adGroupId},${row.assignedAsin},${row.source},${JSON.stringify(row)}::jsonb,${derivedAt}::timestamptz)
      on conflict(org_id,profile_id,ad_group_id) do update set
        asin=case when ad_group_product_assignments.source='manual' then ad_group_product_assignments.asin else excluded.asin end,
        source=case when ad_group_product_assignments.source='manual' then 'manual' else excluded.source end,
        derivation=excluded.derivation,derived_at=excluded.derived_at
      where ad_group_product_assignments.derivation is distinct from excluded.derivation returning ad_group_id`;
    changed += written.length;
  }
  const saved = results.length ? await handle.sql<{ad_group_id:string;source:string;derivation:ProductAssignmentDerivation}[]>`select ad_group_id,source,derivation from public.ad_group_product_assignments where org_id=${scope.orgId} and profile_id=${scope.profileId} and ad_group_id=any(${results.map((row) => row.adGroupId)}::text[])` : [];
  for (const row of saved) {
    const expected = results.find((result) => result.adGroupId === row.ad_group_id)!;
    if (JSON.stringify(ProductAssignmentDerivation.parse(row.derivation)) !== JSON.stringify(expected)) throw new Error('Assignment readback evidence mismatch');
  }
  // `saved` counts rows read back from the table; the caller compares it with the parsed ad groups.
  return { offered:results.length,saved:saved.length,changed,unchanged:results.length-changed,manual:saved.filter((row) => row.source==='manual').length };
}

/** One transaction serializes refreshes per profile and prevents stale snapshots winning. */
export async function withProductAssignmentRefresh<T>(handle: DbHandle, scope: Scope, run: (handle: QueryHandle) => Promise<T>): Promise<T> {
  return await handle.sql.begin('isolation level repeatable read', async (sql) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${`product-assignments:${scope.orgId}:${scope.profileId}`},0))`;
    return run({sql});
  }) as T;
}

export async function listProductAssignments(context: AuthenticatedReadSnapshot | AuthenticatedEditorTransaction, raw: ProductAssignmentScope): Promise<ProductAssignmentList> {
  const scope=ProductAssignmentScope.parse(raw), {sql,actor}=context;
  if ((await sql`select id from public.ad_profiles where org_id=${actor.orgId} and id=${scope.profileId}`).length!==1) throw new AgencyAccessDenied();
  const rows=await sql`select g.amazon_id,g.campaign_id,g.name,a.asin,a.source,a.derived_at,a.derivation,
    (select array_agg(distinct p.asin order by p.asin) from public.product_ads p where p.org_id=g.org_id and p.profile_id=g.profile_id and p.ad_group_id=g.amazon_id and p.asin is not null and p.deleted_at is null and p.state in ('enabled','paused')) as asins,
    (select sum(f.cost)::text from public.fact_sp_target_daily f where f.org_id=g.org_id and f.profile_id=g.profile_id and f.ad_group_id=g.amazon_id and f.campaign_id=g.campaign_id and f.date between ${scope.start} and ${scope.end}) as spend
    from public.ad_groups g left join public.ad_group_product_assignments a on a.org_id=g.org_id and a.profile_id=g.profile_id and a.ad_group_id=g.amazon_id
    where g.org_id=${actor.orgId} and g.profile_id=${scope.profileId} and g.ad_product='SP' and g.deleted_at is null order by g.amazon_id`;
  const items=rows.map((row) => {
    const baseline=row['derivation'] ? ProductAssignmentDerivation.parse(row['derivation']) : null;
    return {adGroupId:row['amazon_id'],campaignId:row['campaign_id'],name:row['name'],asins:row['asins']??[],assignedAsin:row['asin']??null,
      source:row['source']??'unassigned',derivedAt:row['derived_at'] ? new Date(row['derived_at']).toISOString():null,
      derived:baseline ? {asin:baseline.assignedAsin,source:baseline.source} : null,
      ambiguous:row['source']==='proposed',reason:row['source']==='manual'?null:baseline?.reason??null,candidates:baseline?.candidates??[],spend:row['spend']===null?null:Number(row['spend'])};
  });
  // A group the worker has not derived yet is awaiting its first derivation, not unresolved.
  const unresolved=items.filter(unresolvedProductAssignment);
  const [permission]=await sql`select app.has_org_role(${actor.orgId},array['owner','admin','analyst']) as allowed`;
  return ProductAssignmentList.parse({...scope,days:Math.round((Date.parse(scope.end)-Date.parse(scope.start))/86400000)+1,canAssign:permission?.['allowed']===true,
    items,count:items.length,unassignedCount:unresolved.length,unassignedSpend:unresolved.reduce((sum,row) => sum+(row.spend??0),0)});
}

export async function mutateProductAssignment(context: AuthenticatedEditorTransaction, raw: ProductAssignmentMutation): Promise<void> {
  const input=ProductAssignmentMutation.parse(raw),{sql,actor}=context;
  if ((await sql`select id from public.ad_profiles where org_id=${actor.orgId} and id=${input.profileId}`).length!==1) throw new AgencyAccessDenied();
  if (input.action==='assign') {
    // Fail closed, as the screen does: a derived or derived-parent group has nothing to confirm.
    const [current]=await sql<{source:string}[]>`select source from public.ad_group_product_assignments
      where org_id=${actor.orgId} and profile_id=${input.profileId} and ad_group_id=${input.adGroupId} for update`;
    if (current?.source==='derived'||current?.source==='derived_parent') throw new ProductAssignmentRefused('assignment_derived');
  }
  const rows=input.action==='assign'
    ? await sql`insert into public.ad_group_product_assignments(org_id,profile_id,ad_group_id,asin,assigned_by,source)
      values(${actor.orgId},${input.profileId},${input.adGroupId},${input.asin},${actor.userId},'manual')
      on conflict(org_id,profile_id,ad_group_id) do update set asin=excluded.asin,assigned_by=excluded.assigned_by,source='manual' returning ad_group_id`
    : await sql`update public.ad_group_product_assignments set source=coalesce(derivation->>'source','unassigned'),asin=derivation->>'assignedAsin',assigned_by=${actor.userId}
      where org_id=${actor.orgId} and profile_id=${input.profileId} and ad_group_id=${input.adGroupId} and source='manual' returning ad_group_id`;
  if(rows.length!==1) throw new Error('Assignment mutation row count mismatch');
}
