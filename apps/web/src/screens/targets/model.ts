import { readTargetBidContext, type QueryHandle } from '@wizard-ads/db';
import { readCoreReportEvidence } from '@wizard-ads/db';
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
  const identities = await handle.sql<{ ad_group_id: string }[]>`select ad_group_id from public.targets where org_id=${args.orgId} and profile_id=${args.profileId} and amazon_id=${args.targetId} and ad_product=${payload.target.adProduct} union select ad_group_id from public.keywords where org_id=${args.orgId} and profile_id=${args.profileId} and amazon_id=${args.targetId} and ad_product=${payload.target.adProduct}`;
  const adGroupId = identities.length === 1 ? identities[0]!.ad_group_id : null;
  const evidence = await readCoreReportEvidence(handle, { orgId: args.orgId, profileId: args.profileId, startDate: args.from, endDate: args.to, families: ['spTargetMetrics', 'sbTargeting', 'sdTargeting', 'sdTargetingMatchedTarget', 'sdAdGroupMatchedTarget', 'sdCampaignsMatchedTarget', 'spGrossAndInvalids', 'sbGrossAndInvalids', 'sdGrossAndInvalids'], limit: 1000 });
  const coreEvidence = evidence.map((item) => {
    const rows = item.rows.filter((row) => row.dimensions['campaignId'] === payload.target.campaignId && (item.grain === 'traffic_quality' || item.grain === 'sd_campaign_matched_target' || (adGroupId !== null && row.dimensions['adGroupId'] === adGroupId && (item.grain === 'sd_ad_group_matched_target' || (row.dimensions['keywordId'] ?? row.dimensions['targetingId']) === args.targetId))));
    return { ...item, rows, rowCount: rows.length };
  });
  return { payload, ranks, performance, changes, bidContext, ...(coreEvidence.some((item) => item.rowCount > 0) ? { coreEvidence } : {}), profileId: args.profileId, currencyCode };
}
export type Target360Model = NonNullable<Awaited<ReturnType<typeof loadTarget360>>>;
