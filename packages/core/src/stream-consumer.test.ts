import { expect, it } from 'vitest';
import { StreamConsumerSource, StreamExtensionEvent } from '@wizard-ads/shared';
import { deriveStreamConsumerEvidence } from './stream-consumer.js';
const scope={orgId:'00000000-0000-4000-8000-000000000001',profileId:'00000000-0000-4000-8000-000000000002',amazonProfileId:'313',region:'EU'};
const before='2026-09-15T10:00:00.000Z',start='2026-09-15T11:00:00.000Z',end='2026-09-15T12:00:00.000Z',after='2026-09-15T13:00:00.000Z';
const creative={adProduct:'SB',kind:'creative',providerId:'creative',version:'1'},asset={adProduct:'SB',kind:'asset',providerId:'asset',version:'1'},campaign={adProduct:'SB',kind:'campaign',providerId:'campaign',version:null};
const event=StreamExtensionEvent.parse({orgId:scope.orgId,profileId:scope.profileId,identity:'a'.repeat(64),payloadFingerprint:'b'.repeat(64),receivedAt:end,record:{contractVersion:'fixture.v1',subscriptionId:'sub',advertiserId:'advertiser',marketplaceId:'market',region:'EU',destinationArn:'arn:aws:sqs:eu-west-1:000000000000:synthetic',eventId:'event',revision:1,eventTime:end,window:{start,end},datasetId:'sb-clickstream',observation:{creativeId:'creative',campaignId:'campaign',clicks:0}}});
function source() {
  const common={scope,sourceEventAt:before,observedAt:before,revision:'1',payloadFingerprint:'c'.repeat(64),operation:'upsert'};
  return StreamConsumerSource.parse({scope,events:[event],truncated:false,graph:{persistedObservations:3,persistedAssociations:2,
    observations:[creative,asset,campaign].map(identity=>({...common,identity,source:'product_api',contractVersion:'fixture.v1',state:'enabled'})),
    associations:[{...common,from:creative,to:asset,relation:'asset'},{...common,from:creative,to:campaign,relation:'parent'}].map(({observedAt:_,...edge})=>edge)}});
}
const selection={asOf:after,maxAgeMs:86400000,from:start,to:end,assetId:'asset'};
it('attributes a documented zero through exact endpoints and keeps a later tombstone out of an earlier window',()=>{
  const input=source();
  expect(deriveStreamConsumerEvidence(input,selection)).toMatchObject({measured:1,unresolved:0});
  input.graph.associations.push({...input.graph.associations[1]!,operation:'tombstone',revision:'2',sourceEventAt:after});
  expect(deriveStreamConsumerEvidence(input,selection)).toMatchObject({measured:1,unresolved:0});
});
it('refuses a campaign tombstone inside the window and equal-revision endpoint conflicts',()=>{
  const input=source();
  input.graph.associations.push({...input.graph.associations[1]!,operation:'tombstone',revision:'2',sourceEventAt:'2026-09-15T11:30:00.000Z'});
  expect(deriveStreamConsumerEvidence(input,selection)).toMatchObject({measured:0,unresolved:1});
  input.graph.associations.push({...input.graph.associations[1]!,revision:'3',sourceEventAt:'2026-09-15T11:45:00.000Z'});
  expect(deriveStreamConsumerEvidence(input,selection)).toMatchObject({measured:0,unresolved:1});
  const conflict=source();conflict.graph.observations.push({...conflict.graph.observations[0]!,payloadFingerprint:'e'.repeat(64),operation:'tombstone'});
  expect(deriveStreamConsumerEvidence(conflict,selection)).toMatchObject({measured:0,unresolved:1});
});
it('distinguishes disjoint periods, unresolved partial windows and stale source facts',()=>{
  expect(deriveStreamConsumerEvidence(source(),{...selection,from:after,to:'2026-09-15T14:00:00.000Z'})).toMatchObject({measured:0,unresolved:0,excluded:1});
  expect(deriveStreamConsumerEvidence(source(),{...selection,from:'2026-09-15T11:30:00.000Z'})).toMatchObject({measured:0,unresolved:1});
  expect(deriveStreamConsumerEvidence(source(),{...selection,asOf:'2026-09-20T00:00:00.000Z'})).toMatchObject({measured:1,completeness:'stale',staleEventIds:[event.identity]});
});
it('keeps version ambiguity unresolved, reports truncated history and exposes no mutation authority',()=>{
  const input=source();const next={...input.graph.observations[1]!,identity:{...input.graph.observations[1]!.identity,version:'2'}};
  input.graph.observations.push(next);input.graph.associations.push({...input.graph.associations[0]!,to:next.identity});
  input.truncated=true;
  expect(deriveStreamConsumerEvidence(input,selection)).toMatchObject({measured:0,unresolved:1,truncated:true,mutationAuthority:false});
});
