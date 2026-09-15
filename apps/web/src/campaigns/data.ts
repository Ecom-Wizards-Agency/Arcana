import { listCampaignKeywordSets, listCampaignNamingPresets, type AuthenticatedEditorTransaction, type AuthenticatedReadSnapshot } from '@wizard-ads/db';
import { aggregateNgrams, spCoordinatedCapabilities } from '@wizard-ads/core';
import { CampaignBuilderContext, TenantStrategy, spMarketplaceBudgetCapability, spMarketplaceScopeForCountry, Uuid } from '@wizard-ads/shared';
import { listProfiles } from '../../app/_lib/profiles';

/** All builder evidence is read in the caller's authenticated snapshot/transaction. */
export async function loadCampaignBuilderContext(context: AuthenticatedReadSnapshot | AuthenticatedEditorTransaction, profileId: string): Promise<CampaignBuilderContext> {
  Uuid.parse(profileId);
  const orgId = context.actor.orgId;
  const profile = (await listProfiles({ sql: context.sql }, orgId)).find((item) => item.id === profileId);
  if (!profile) throw new Error('Profile unavailable');
  const rows = await context.sql<{ doc: unknown }[]>`select doc from public.profile_strategy where org_id=${orgId}::uuid
    and (profile_id=${profileId}::uuid or profile_id is null) order by profile_id nulls last,updated_at desc limit 1`;
  const strategy = rows[0] ? TenantStrategy.parse(rows[0].doc) : null;
  const products = await context.sql`select distinct on (asin) asin as key,asin,sku,asin as name,state::text,
    synced_at::text as "observedAt" from public.product_ads
    where org_id=${orgId}::uuid and profile_id=${profileId}::uuid and asin is not null and state <> 'archived' and deleted_at is null
    order by asin,synced_at desc,amazon_id`;
  const groups = await context.sql`select id,name,role::text,target_acos::float8 as "targetAcos",bid_floor::float8 as floor,bid_ceiling::float8 as ceiling
    from public.optimization_groups where org_id=${orgId}::uuid and profile_id=${profileId}::uuid order by name,id`;
  const membership = await context.sql<{ role: string }[]>`select role::text from public.org_members where org_id=${orgId}::uuid and user_id=${context.actor.userId}::uuid`;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: profile.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const coverage = await context.sql<{ end: string | null }[]>`select max(c.latest_settled_date)::text as end from public.report_coverage c
    where c.org_id=${orgId}::uuid and c.profile_id=${profileId}::uuid and c.report_type='spTargeting' and c.status='complete'
      and c.grain='sp_target' and c.source='amazon_reporting_v3' and c.counts_match is true and c.refused_rows=0
      and c.latest_settled_date <= ${today}::date
      and (select count(distinct w.report_date) from public.report_promotion_watermarks w
        where w.org_id=c.org_id and w.profile_id=c.profile_id and w.report_type=c.report_type and w.source::text=c.source
          and w.report_date between c.latest_settled_date-29 and c.latest_settled_date
          and w.refused_rows=0 and w.source_rows=w.parsed_rows and w.parsed_rows=w.promoted_rows and w.promoted_rows=w.canonical_rows)=30`;
  const end = coverage[0]?.end ?? null;
  const start = end === null ? null : new Date(Date.parse(end) - 29 * 86_400_000).toISOString().slice(0, 10);
  const bidEvidence = end === null ? [] : await context.sql`select lower(btrim(k.keyword_text)) as keyword,
    sum(f.clicks)::int as clicks,sum(f.cost)::float8 as spend,null::float8 as "reportedCpc",count(distinct f.date)::int as days,
    ${start}::text as start,${end}::text as end,'fact_sp_target_daily' as source,count(*)::int as "sourceRows",sum(f.sales_14d)::float8 as sales
    from public.fact_sp_target_daily f join public.keywords k on k.org_id=f.org_id and k.profile_id=f.profile_id
      and k.campaign_id=f.campaign_id and k.ad_group_id=f.ad_group_id and k.amazon_id=f.target_id
    where f.org_id=${orgId}::uuid and f.profile_id=${profileId}::uuid and f.ad_product='SP'
      and f.target_kind='keyword' and f.date between ${start}::date and ${end}::date
      and exists(select 1 from public.report_promotion_watermarks w where w.org_id=f.org_id and w.profile_id=f.profile_id
        and w.report_type='spTargeting' and w.source='amazon_reporting_v3' and w.report_date=f.date and w.report_request_id=f.report_request_id)
    group by lower(btrim(k.keyword_text))`;
  const terms = await context.sql<{ searchTerm: string; impressions: number; clicks: number; cost: number; purchases7d: number; sales7d: number }[]>`
    select search_term as "searchTerm",sum(impressions)::int as impressions,sum(clicks)::int as clicks,sum(cost)::float8 as cost,
      sum(purchases_7d)::int as "purchases7d",sum(sales_7d)::float8 as "sales7d"
    from public.fact_search_term_daily where org_id=${orgId}::uuid and profile_id=${profileId}::uuid
      and date between coalesce(${start}::date,${today}::date-29) and coalesce(${end}::date,${today}::date)
    group by search_term order by search_term`;
  const sqp = await context.sql<{ present: boolean }[]>`select exists(select 1 from public.fact_sqp_weekly where org_id=${orgId}::uuid and profile_id=${profileId}::uuid) as present`;
  const marketplace = spMarketplaceScopeForCountry(profile.countryCode, profile.region, profile.currencyCode);
  return CampaignBuilderContext.parse({
    profile: { id: profile.id, label: profile.label, countryCode: profile.countryCode, currencyCode: profile.currencyCode, marketplace: marketplace ?? null },
    products, groups, naming: strategy?.naming ?? null, presets: await listCampaignNamingPresets(context),
    keywordSets: await listCampaignKeywordSets(context, profileId), searchTerms: terms.map((term) => term.searchTerm),
    ngrams: aggregateNgrams(terms).map((row) => row.gram), bidEvidence, sqpMeasured: sqp[0]?.present === true,
    exposureCeiling: strategy?.caps?.campaign_exposure_ceiling ?? null,
    budget: spMarketplaceBudgetCapability(marketplace), capabilities: spCoordinatedCapabilities(marketplace),
    canEdit: membership.some((row) => ['owner', 'admin', 'analyst'].includes(row.role)), today,
    defaults: { budget: null, topOfSearch: null },
  });
}
