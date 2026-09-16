import { readTargetBidContext, readSpReportEvidence, type QueryHandle } from '@wizard-ads/db';
import { readCoreReportEvidence } from '@wizard-ads/db';
import { loadBidHistory, loadTargetChanges, loadTargetPerformance, loadTargetRanks } from '../../../app/_lib/bid-corridor';
export async function loadTarget360(handle: QueryHandle, args: { orgId: string; profileId: string; targetId: string; from: string; to: string }) {
  const profiles = await handle.sql<{ currency_code: string }[]>`select currency_code from public.ad_profiles where org_id=${args.orgId} and id=${args.profileId}`;
  if (profiles.length !== 1) return null;
  const currencyCode = profiles[0]!.currency_code;
  const payload = await loadBidHistory(handle, args);
  if (payload === null) return null;
  const [ranks, performance, changes, bidContext, searchEvidence] = await Promise.all([
    loadTargetRanks(handle, args.orgId, args.profileId, payload),
    loadTargetPerformance(handle, args.orgId, args.profileId, args.targetId, payload.window),
    loadTargetChanges(handle, args.orgId, args.profileId, args.targetId, payload.window),
    readTargetBidContext(handle, args.orgId, args.profileId, args.targetId),
    loadTargetSearchEvidence(handle, args, payload.target),
  ]);
  const facts = new Map(performance.map((row) => [row.date, row]));
  // Maximum CPC is worker evidence, including a known base bid with zero uplifts.
  payload.points = payload.points.map((p) => ({ ...p, cpc: facts.get(p.date)?.cpc ?? null }));
  const identities = await handle.sql<{ ad_group_id: string }[]>`select ad_group_id from public.targets where org_id=${args.orgId} and profile_id=${args.profileId} and amazon_id=${args.targetId} and ad_product=${payload.target.adProduct} union select ad_group_id from public.keywords where org_id=${args.orgId} and profile_id=${args.profileId} and amazon_id=${args.targetId} and ad_product=${payload.target.adProduct}`;
  const adGroupId = identities.length === 1 ? identities[0]!.ad_group_id : null;
  const evidence = await readCoreReportEvidence(handle, { orgId: args.orgId, profileId: args.profileId, startDate: args.from, endDate: args.to, families: ['spTargetMetrics', 'sbTargeting', 'sdTargeting', 'sdTargetingMatchedTarget', 'sdAdGroupMatchedTarget', 'sdCampaignsMatchedTarget', 'spGrossAndInvalids', 'sbGrossAndInvalids', 'sdGrossAndInvalids'], limit: 1000 });
  const coreEvidence = evidence.map((item) => {
    const rows = item.rows.filter((row) => row.dimensions['campaignId'] === payload.target.campaignId && (item.grain === 'traffic_quality' || item.grain === 'sd_campaign_matched_target' || (adGroupId !== null && row.dimensions['adGroupId'] === adGroupId && (item.grain === 'sd_ad_group_matched_target' || (row.dimensions['keywordId'] ?? row.dimensions['targetingId']) === args.targetId))));
    return { ...item, rows, rowCount: rows.length };
  });
  return { ...({ searchEvidence } as { searchEvidence?: Awaited<ReturnType<typeof loadTargetSearchEvidence>> }), payload, ranks, performance, changes, bidContext, ...(coreEvidence.some((item) => item.rowCount > 0) ? { coreEvidence } : {}), profileId: args.profileId, currencyCode };
}
export type Target360Model = NonNullable<Awaited<ReturnType<typeof loadTarget360>>>;

/** Existing authenticated target read: exact keyword and current unique ASIN mapping. */
export async function loadTargetSearchEvidence(handle: QueryHandle, args: { orgId: string; profileId: string; targetId: string; from: string; to: string }, targeting: { targetKind: string; matchType: string | null; targeting: string }) {
  const aba = await readSpReportEvidence(handle, { orgId: args.orgId, profileId: args.profileId, family: 'aba', start: args.from, end: args.to });
  const empty = { aba, asin: null as string | null, sqp: [] as { asin: string; query: string; start: string; end: string; observedAt: string; impressionShare: number | null; purchaseShare: number | null }[] };
  if (targeting.targetKind !== 'keyword' || targeting.matchType === 'broad') return empty;
  const identities = await handle.sql<{ asin: string }[]>`
    select distinct p.asin from public.product_ads p join public.keywords k
      on k.org_id=p.org_id and k.profile_id=p.profile_id and k.campaign_id=p.campaign_id and k.ad_group_id=p.ad_group_id
    where k.org_id=${args.orgId} and k.profile_id=${args.profileId} and k.amazon_id=${args.targetId}
      and k.deleted_at is null and p.deleted_at is null and p.asin is not null`;
  if (identities.length !== 1) return empty;
  const asin = identities[0]!.asin;
  const sqp = await handle.sql<{ asin: string; query: string; start: string; end: string; observedAt: string; impressionShare: number | null; purchaseShare: number | null }[]>`
    select q.asin,q.search_query as query,q.week_start::text as start,q.week_end::text as end,
      r.completed_at::text as "observedAt", q.impression_share::float8 as "impressionShare",q.purchase_share::float8 as "purchaseShare"
    from public.fact_sqp_weekly q
    join public.spapi_profile_bindings b on b.org_id=q.org_id and b.profile_id=q.profile_id and b.marketplace_id=q.marketplace_id and b.enabled
    join public.spapi_connections c on c.org_id=b.org_id and c.id=b.connection_id and c.status='active'
      and c.vault_secret_id is not null and nullif(btrim(c.selling_partner_id),'') is not null and b.marketplace_id=any(c.marketplace_ids)
    join public.ad_profiles profile on profile.org_id=q.org_id and profile.id=q.profile_id and profile.sync_enabled
      and profile.region=app.spapi_region_for_marketplace(b.marketplace_id)
    join lateral (select run.* from public.sqp_promotion_runs run
      where run.org_id=q.org_id and run.profile_id=q.profile_id and run.marketplace_id=q.marketplace_id and run.week_start=q.week_start
        and q.asin=any(run.requested_asins) and run.refused_rows=0
        and run.source_rows=run.parsed_rows+run.refused_rows and run.parsed_rows>=run.deduplicated_rows and run.deduplicated_rows=run.promoted_rows and run.promoted_rows=run.canonical_rows
        and run.canonical_rows=(select count(*) from public.fact_sqp_weekly loaded where loaded.org_id=run.org_id and loaded.profile_id=run.profile_id
          and loaded.marketplace_id=run.marketplace_id and loaded.week_start=run.week_start and loaded.asin=any(run.requested_asins))
      order by run.completed_at desc limit 1) r on true
    where q.org_id=${args.orgId} and q.profile_id=${args.profileId} and q.asin=${asin} and q.search_query=${targeting.targeting}
      and q.week_start>=${args.from}::date and q.week_end<=${args.to}::date order by q.week_start`;
  return { aba, asin, sqp };
}
