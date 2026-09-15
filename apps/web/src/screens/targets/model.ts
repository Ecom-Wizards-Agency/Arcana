import { readProductEvidence, readTargetBidContext, type QueryHandle } from '@wizard-ads/db';
import { AdProduct } from '@wizard-ads/shared';
import { loadBidHistory, loadTargetChanges, loadTargetPerformance, loadTargetRanks } from '../../../app/_lib/bid-corridor';
export async function loadTarget360(handle: QueryHandle, args: { orgId: string; profileId: string; targetId: string; from: string; to: string }) {
  const profiles = await handle.sql<{ currency_code: string }[]>`select currency_code from public.ad_profiles where org_id=${args.orgId} and id=${args.profileId}`;
  if (profiles.length !== 1) return null;
  const currencyCode = profiles[0]!.currency_code;
  const payload = await loadBidHistory(handle, args);
  if (payload === null) return null;
  const [ranks, performance, changes, bidContext] = await Promise.all([
    loadTargetRanks(handle, args.orgId, args.profileId, payload),
    loadTargetPerformance(handle, args.orgId, args.profileId, args.targetId, payload.window),
    loadTargetChanges(handle, args.orgId, args.profileId, args.targetId, payload.window),
    readTargetBidContext(handle, args.orgId, args.profileId, args.targetId),
  ]);
  const facts = new Map(performance.map((row) => [row.date, row]));
  // Maximum CPC is worker evidence, including a known base bid with zero uplifts.
  payload.points = payload.points.map((p) => ({ ...p, cpc: facts.get(p.date)?.cpc ?? null }));
  const advertised = await handle.sql<{ asin:string }[]>`select distinct asin from public.product_ads where org_id=${args.orgId}
    and profile_id=${args.profileId} and campaign_id=${payload.target.campaignId} and asin is not null and deleted_at is null order by asin`;
  const asins = [...new Set([...advertised.map((row) => row.asin), ...ranks.map((row) => row.asin)])];
  const adProduct = AdProduct.safeParse(payload.target.adProduct);
  const marketplaces = asins.length === 0 ? [] : await handle.sql<{ marketplace_id:string }[]>`select distinct marketplace_id from (
    select marketplace_id from public.ads_product_metadata_snapshots where org_id=${args.orgId} and profile_id=${args.profileId} and asin=any(${asins}::text[])
    union select marketplace_id from public.ads_product_eligibility_snapshots where org_id=${args.orgId} and profile_id=${args.profileId} and asin=any(${asins}::text[])) scoped order by marketplace_id`;
  const staleAfter = new Date(Date.now()-48*60*60*1000).toISOString();
  const shelf = !adProduct.success ? [] : (await Promise.all(marketplaces.map(({marketplace_id}) => readProductEvidence(handle,{scope:{orgId:args.orgId,profileId:args.profileId,marketplaceId:marketplace_id},asins,adProduct:adProduct.data,staleAfter})))).flat();
  return { payload, ranks, performance, changes, bidContext, shelf, profileId: args.profileId, currencyCode };
}
export type Target360Model = NonNullable<Awaited<ReturnType<typeof loadTarget360>>>;
