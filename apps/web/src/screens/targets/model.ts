import { readTargetBidContext, type QueryHandle } from '@wizard-ads/db';
import { corridorMaxCpc } from '@wizard-ads/core';
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
  payload.points = payload.points.map((p) => ({ ...p, cpc: facts.get(p.date)?.cpc ?? null, maxCpc: corridorMaxCpc(p.bid, p.components) }));
  return { payload, ranks, performance, changes, bidContext, profileId: args.profileId, currencyCode };
}
export type Target360Model = NonNullable<Awaited<ReturnType<typeof loadTarget360>>>;
