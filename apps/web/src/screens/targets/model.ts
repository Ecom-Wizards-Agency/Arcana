import { readProviderGraphEvidence, readTargetBidContext, type QueryHandle } from '@wizard-ads/db';
import { reconcileProviderGraph } from '@wizard-ads/core';
import { ProviderGraphScope, providerGraphIdentityKey, AdProduct, type ProviderGraphAssociation } from '@wizard-ads/shared';
import { loadBidHistory, loadTargetChanges, loadTargetPerformance, loadTargetRanks } from '../../../app/_lib/bid-corridor';

export interface Target360GraphEvidence {
  status: 'observed' | 'partial' | 'stale' | 'missing';
  unresolvedCount: number;
  observation?: { state: string; sourceEventAt: string; source: string };
  rows: { relation: ProviderGraphAssociation['relation']; kind: ProviderGraphAssociation['to']['kind'];
    providerId: string; version: string | null; source: 'product_api' | 'marketing_stream';
    sourceEventAt: string; stale: boolean }[];
}

/** Exact authenticated profile and entity type; numeric keyword/target IDs are not interchangeable. */
export async function loadTargetGraphEvidence(handle: QueryHandle, args: {
  scope: ProviderGraphScope; targetId: string; adProduct: AdProduct; targetKind: string;
  asOf: string; maxAgeMs: number;
}): Promise<Target360GraphEvidence> {
  if (!Number.isFinite(args.maxAgeMs) || args.maxAgeMs<=0 || !Number.isFinite(Date.parse(args.asOf))) throw new Error('Invalid graph evidence age');
  if (args.targetKind !== 'product target' && args.targetKind !== 'target') return { status: 'missing',rows:[],unresolvedCount:0 };
  const evidence=await readProviderGraphEvidence(handle,args.scope,args.asOf);
  const graph=reconcileProviderGraph({scope:args.scope,observations:evidence.observations,associations:evidence.associations});
  const identity={adProduct:args.adProduct,kind:'target' as const,providerId:args.targetId,version:null};
  const key=providerGraphIdentityKey(args.scope,identity);
  const matches=(edge: ProviderGraphAssociation) => providerGraphIdentityKey(edge.scope,edge.from)===key;
  const nodes=new Map(graph.nodes.map((node) => [providerGraphIdentityKey(node.scope,node.identity),node]));
  const rows=graph.resolved.filter(matches).map((edge) => ({relation:edge.relation,kind:edge.to.kind,
    providerId:edge.to.providerId,version:edge.to.version,source:nodes.get(key)!.source,
    sourceEventAt:edge.sourceEventAt,stale:Date.parse(args.asOf)-Date.parse(edge.sourceEventAt)>args.maxAgeMs}));
  const unresolvedCount=graph.unresolved.filter((entry) => matches(entry.association)).length;
  const node = nodes.get(key);
  return {rows,unresolvedCount,...(node ? { observation: { state: node.state, sourceEventAt: node.sourceEventAt, source: node.source } } : {}),status:rows.length===0 ? node ? Date.parse(args.asOf)-Date.parse(node.sourceEventAt)>args.maxAgeMs ? 'stale' : 'partial' : unresolvedCount>0 ? 'partial' : 'missing'
    : rows.every((row) => row.stale) ? 'stale' : unresolvedCount>0 || rows.some((row) => row.stale) ? 'partial' : 'observed'};
}

export async function loadTarget360(handle: QueryHandle, args: { orgId: string; profileId: string; targetId: string; from: string; to: string }) {
  const profiles = await handle.sql<{ currency_code: string; amazon_profile_id: string; region: string }[]>`select currency_code,amazon_profile_id,region from public.ad_profiles where org_id=${args.orgId} and id=${args.profileId}`;
  if (profiles.length !== 1) return null;
  const currencyCode = profiles[0]!.currency_code;
  const payload = await loadBidHistory(handle, args);
  if (payload === null) return null;
  const [ranks, performance, changes, bidContext, graph] = await Promise.all([
    loadTargetRanks(handle, args.orgId, args.profileId, payload),
    loadTargetPerformance(handle, args.orgId, args.profileId, args.targetId, payload.window),
    loadTargetChanges(handle, args.orgId, args.profileId, args.targetId, payload.window),
    readTargetBidContext(handle, args.orgId, args.profileId, args.targetId),
    loadTargetGraphEvidence(handle,{scope:ProviderGraphScope.parse({orgId:args.orgId,profileId:args.profileId,
      amazonProfileId:profiles[0]!.amazon_profile_id,region:profiles[0]!.region}),targetId:args.targetId,
      adProduct:AdProduct.parse(payload.target.adProduct),targetKind:payload.target.targetKind,
      asOf:new Date().toISOString(),maxAgeMs:24*60*60*1000}),
  ]);
  const facts = new Map(performance.map((row) => [row.date, row]));
  // Maximum CPC is worker evidence, including a known base bid with zero uplifts.
  payload.points = payload.points.map((p) => ({ ...p, cpc: facts.get(p.date)?.cpc ?? null }));
  const graphEvidence: {graph?:Target360GraphEvidence}={graph};
  return { payload, ranks, performance, changes, bidContext, ...graphEvidence, profileId: args.profileId, currencyCode };
}
export type Target360Model = NonNullable<Awaited<ReturnType<typeof loadTarget360>>>;
