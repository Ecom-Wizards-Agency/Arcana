import { BrandLensCampaign, BrandLensKeyword, BrandLensOverride, BrandLensOverrideInput, normalizeResearchQuery } from '@wizard-ads/shared';
import type { AuthenticatedEditorTransaction, AuthenticatedReadSnapshot } from './authenticated-actor.js';
import { listQueryVocabularyForActor, readResearchProfile } from './sqp.js';
export async function readBrandLens(context: AuthenticatedReadSnapshot | AuthenticatedEditorTransaction, profileId: string, window: { start: string; end: string }) {
  const profile = await readResearchProfile(context, profileId);
  const { sql, actor } = context;
  const [vocabulary, keywords, overrides, campaigns] = await Promise.all([
    listQueryVocabularyForActor(context, profileId),
    sql`select k.amazon_id as id,k.campaign_id as "campaignId",k.keyword_text as keyword,k.match_type::text as "matchType",
      f.spend,f.sales,f.clicks,f.orders from public.keywords k left join lateral (
        select sum(cost)::float8 as spend,sum(sales_7d)::float8 as sales,sum(clicks)::float8 as clicks,sum(purchases_7d)::float8 as orders
        from public.fact_sp_target_daily f where f.org_id=k.org_id and f.profile_id=k.profile_id and f.target_id=k.amazon_id
        and f.campaign_id=k.campaign_id and f.ad_group_id=k.ad_group_id and f.match_type=k.match_type
        and f.date between ${window.start}::date and ${window.end}::date
      ) f on true where k.org_id=${actor.orgId} and k.profile_id=${profileId} and k.deleted_at is null order by k.keyword_text,k.amazon_id`,
    sql`select org_id as "orgId",profile_id as "profileId",normalized_keyword as "normalizedKeyword",bucket,decision,decided_by as "decidedBy",decided_at as "decidedAt"
      from public.brand_lens_overrides where org_id=${actor.orgId} and profile_id=${profileId} order by normalized_keyword`,
    sql`select c.amazon_id as id,coalesce(c.name,c.amazon_id) as name,a.group_id as "groupId",g.role::text as "groupRole",
      coalesce(c.amazon_id=any(g.exclusions),false) as excluded from public.campaigns c
      left join public.campaign_optimization_assignments a on a.org_id=c.org_id and a.profile_id=c.profile_id and a.campaign_id=c.amazon_id
      left join public.optimization_groups g on g.id=a.group_id and g.org_id=a.org_id and g.profile_id=a.profile_id
      where c.org_id=${actor.orgId} and c.profile_id=${profileId} and c.deleted_at is null order by c.name,c.amazon_id`,
  ]);
  return {
    profile,
    vocabulary,
    keywords: keywords.map((r) => BrandLensKeyword.parse(r)),
    campaigns: campaigns.map((r) => BrandLensCampaign.parse(r)),
    overrides: overrides.map((r) => BrandLensOverride.parse({
      ...r,
      decidedAt: new Date(r['decidedAt']).toISOString()
    }))
  };
}
export async function saveBrandLensOverride(context: AuthenticatedEditorTransaction, raw: BrandLensOverrideInput) {
  const input = BrandLensOverrideInput.parse(raw);
  const normalizedKeyword = normalizeResearchQuery(input.keyword);
  await readResearchProfile(context, input.profileId);
  const rows = await context.sql`insert into public.brand_lens_overrides(org_id,profile_id,normalized_keyword,bucket,decision,decided_by)
    values(${context.actor.orgId},${input.profileId},${normalizedKeyword},${input.bucket},${input.decision},${context.actor.userId})
    on conflict(org_id,profile_id,normalized_keyword) do update set bucket=excluded.bucket,decision=excluded.decision,decided_by=excluded.decided_by,decided_at=now()
    returning normalized_keyword`;
  if (rows.length !== 1) throw new Error('Override count mismatch');
  return { changed: rows.length };
}
export async function removeBrandLensOverride(context: AuthenticatedEditorTransaction, profileId: string, normalizedKeyword: string) {
  await readResearchProfile(context, profileId);
  const rows = await context.sql`delete from public.brand_lens_overrides where org_id=${context.actor.orgId} and profile_id=${profileId} and normalized_keyword=${normalizedKeyword} returning normalized_keyword`;
  return { changed: rows.length };
}
