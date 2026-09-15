import { StreamConsumerEvidence, type StreamConsumerSource, type StreamConsumerSelection,
  type ProviderGraphAssociation, providerGraphIdentityKey } from '@wizard-ads/shared';
import { reconcileProviderGraph } from './provider-graph.js';

/** All consumers use the same revision/conflict rules as the graph projection. */
export function deriveStreamConsumerEvidence(source: StreamConsumerSource, input: StreamConsumerSelection): StreamConsumerEvidence {
  if (!Number.isFinite(Date.parse(input.asOf)) || !Number.isFinite(input.maxAgeMs) || input.maxAgeMs<=0) throw new Error('Invalid Stream reader clock');
  const graphAt = (at: string) => reconcileProviderGraph({ scope: source.scope,
    observations: source.graph.observations.filter(n=>n.sourceEventAt<=at),
    associations: source.graph.associations.filter(e=>e.sourceEventAt<=at),
  });
  const current = graphAt(input.asOf);
  const events: StreamConsumerEvidence['events'] = [], associations = new Map<string,ProviderGraphAssociation>();
  let unresolved = 0, excluded = 0;
  for (const event of source.events) {
    const r=event.record,o=r.observation;
    const campaignId='campaignId' in o ? o.campaignId : r.datasetId==='ads-campaign-management-campaigns' && 'entityId' in o ? o.entityId : null;
    if (input.campaignId && campaignId!==input.campaignId || input.entityId && (!('entityId' in o) || o.entityId!==input.entityId)
      || input.asin && (!('asin' in o) || o.asin!==input.asin)) {excluded++;continue;}
    let edges: ProviderGraphAssociation[]=[];
    if ('creativeId' in o) {
      if (!r.window) {unresolved++;continue;}
      if (input.from && r.window.end<=input.from || input.to && r.window.start>=input.to) {excluded++;continue;}
      if (input.from && r.window.start<input.from || input.to && r.window.end>input.to) {unresolved++;continue;}
      const attachment = (at:string) => {
        const graph=graphAt(at);
        const candidates=graph.resolved.filter(e=>e.from.adProduct==='SB' && e.from.kind==='creative' && e.from.providerId===o.creativeId);
        const assets=candidates.filter(e=>e.relation==='asset' && e.to.kind==='asset' && e.to.version!==null);
        const campaigns=candidates.filter(e=>e.relation==='parent' && e.to.kind==='campaign');
        if (assets.length!==1 || campaigns.length!==1 || campaigns[0]!.to.providerId!==o.campaignId
          || JSON.stringify(assets[0]!.from)!==JSON.stringify(campaigns[0]!.from)) return null;
        return {asset:assets[0]!,campaign:campaigns[0]!};
      };
      const first=attachment(r.window.start);
      const transitions=new Set([r.window.end,...source.graph.observations.map(n=>n.sourceEventAt),
        ...source.graph.associations.map(e=>e.sourceEventAt)].filter(at=>at>r.window!.start && at<=r.window!.end));
      if (!first || [...transitions].some(at=>{
        const next=attachment(at);
        return !next || JSON.stringify(first.asset.to)!==JSON.stringify(next.asset.to)
          || JSON.stringify(first.asset.from)!==JSON.stringify(next.asset.from);
      })) {unresolved++;continue;}
      if (input.assetId && first.asset.to.providerId!==input.assetId) {excluded++;continue;}
      edges=[first.asset,first.campaign];
    } else if ('entityId' in o && !input.history) {
      const kind=r.datasetId==='ads-campaign-management-campaigns'?'campaign':r.datasetId==='ads-campaign-management-adgroups'?'ad_group':r.datasetId==='ads-campaign-management-ads'?'ad':'target';
      const key=providerGraphIdentityKey(source.scope,{adProduct:o.adProduct,kind,providerId:o.entityId,version:null});
      const node=current.nodes.find(n=>providerGraphIdentityKey(n.scope,n.identity)===key);
      if (!node || node.source!=='marketing_stream' || node.payloadFingerprint!==event.payloadFingerprint) {unresolved++;continue;}
      edges=current.resolved.filter(e=>providerGraphIdentityKey(e.scope,e.from)===key);
      const required=[...('campaignId' in o?['campaign']:[]),...('adGroupId' in o?['ad_group']:[]),...('asin' in o?['product']:[]),...('assetId' in o?['asset']:[])];
      if (required.some(kind=>!edges.some(e=>e.to.kind===kind))) {unresolved++;continue;}
      if (input.assetId && !edges.some(e=>e.to.kind==='asset' && e.to.providerId===input.assetId)) {excluded++;continue;}
    } else if (input.assetId) {excluded++;continue;}
    events.push(event);for(const edge of edges) associations.set(JSON.stringify(edge),edge);
  }
  const staleEventIds=events.filter(e=>Date.parse(input.asOf)-Date.parse(e.record.eventTime)>input.maxAgeMs).map(e=>e.identity);
  return StreamConsumerEvidence.parse({events,measured:events.length,unresolved,excluded,associations:[...associations.values()],staleEventIds,truncated:source.truncated,
    source:'amazon_marketing_stream',mutationAuthority:false,completeness:events.length===0?'missing':staleEventIds.length===events.length?'stale':'partial'});
}
