import { beforeAll,afterAll,expect,it } from 'vitest';
import { createHash } from 'node:crypto';
import type { CollectorScope,EffectiveBidObservation,ListingSnapshot,StoredCollectorExport } from '@wizard-ads/shared';
import { createTestDatabase,type TestDatabase } from '../testing/harness.js';
import { asUser } from '../testing/rls.js';
import { readOwnBidMirrors,persistEffectiveBidObservations,persistListingSnapshots,readListingChanges,readListingEvidence,readEffectiveBidObservations } from './own-collectors.js';
import { importScheduledPrompts,readSponsoredPrompts } from './sponsored-prompts.js';
import { readTimeline } from './timeline.js';
let db:TestDatabase,scope:CollectorScope,foreign:CollectorScope,asin:string,campaignId:string,adGroupId:string;
const owner='00000000-0000-4000-8000-000000000091',outsider='00000000-0000-4000-8000-000000000092';
const at=(day:number)=>`2026-06-${String(day).padStart(2,'0')}T00:00:00.000Z`;
beforeAll(async()=>{
  db=await createTestDatabase('wp291_own');
  const [a]=await db.sql<{id:string}[]>`select app.seed_tenant_fixture('synthetic-own-a',${owner},'owner') as id`;
  const [b]=await db.sql<{id:string}[]>`select app.seed_tenant_fixture('synthetic-own-b',${outsider},'owner') as id`;
  const [p]=await db.sql<{id:string}[]>`select id from public.ad_profiles where org_id=${a!.id}`;
  const [q]=await db.sql<{id:string}[]>`select id from public.ad_profiles where org_id=${b!.id}`;
  scope={orgId:a!.id,profileId:p!.id,marketplace:'US'};
  foreign={orgId:b!.id,profileId:q!.id,marketplace:'US'};
  const [product]=await db.sql<{asin:string;campaign_id:string;ad_group_id:string}[]>`select asin,campaign_id,ad_group_id from public.product_ads where org_id=${scope.orgId} and profile_id=${scope.profileId} and ad_product='SP' limit 1`;
  asin=product!.asin;campaignId=product!.campaign_id;adGroupId=product!.ad_group_id;
},60000);
afterAll(async()=>{await db?.drop();});
function listing(day:number,value:number,source='synthetic'):ListingSnapshot{return {scope,asin,sourceIdentity:`day-${day}`,collectedAt:at(10),fields:[{field:'price',value,provenance:{source,sourceIdentity:asin,observedAt:at(day),collectedAt:at(10)}}]};}
const derive:Parameters<typeof persistListingSnapshots>[3]=(input)=>{
  if(input.previous?.value===input.current.value)return null;
  const from=input.previous?.provenance.observedAt ?? null;
  const width=from?(Date.parse(input.current.provenance.observedAt)-Date.parse(from))/86400000:null;
  return {id:input.id,scope:input.scope,asin:input.asin,previous:input.previous,current:input.current,certainty:{kind:from===null?'first':width!<=1&&input.previous?.provenance.source===input.current.provenance.source?'exact':'window',from,to:input.current.provenance.observedAt,widthDays:width}};
};
it('verifies immutable listing identities and freezes certainty after late replay',async()=>{
  expect(await persistListingSnapshots(db,scope,[listing(1,1)],derive)).toMatchObject({inserted:1,alreadyPresent:0,counts:{sourceRows:1,loadedRows:1,verifiedLoadedRows:1}});
  await persistListingSnapshots(db,scope,[listing(5,3)],derive);
  const original=(await readListingChanges(db,{...scope,from:'2026-06-01',to:'2026-06-10'})).find((r)=>r.current.provenance.observedAt===at(5))!;
  expect(original.certainty).toMatchObject({kind:'window',widthDays:4});
  await persistListingSnapshots(db,scope,[listing(4,2)],derive);
  const replay=await persistListingSnapshots(db,scope,[{...listing(5,3),collectedAt:at(11)}],derive);
  expect(replay).toMatchObject({inserted:0,alreadyPresent:1,observedAt:at(5)});
  expect((await readListingChanges(db,{...scope,from:'2026-06-01',to:'2026-06-10'})).find((r)=>r.id===original.id)).toEqual(original);
  await expect(persistListingSnapshots(db,scope,[listing(5,9)],derive)).rejects.toThrow('conflict');
  await expect(db.sql`update public.own_listing_changes set change='{}' where id=${original.id}`).rejects.toThrow('immutable');
});
it('returns partial/stale/absent evidence without price-derived eligibility',async()=>{
  const [fresh]=await readListingEvidence(db,{...scope,asins:[asin],asOf:at(5),maxAgeMs:86400000});
  expect(fresh?.availability).toBe('partial');expect(fresh?.moderation).toBe('unavailable');
  expect(fresh?.fields.map((f)=>f.observation.field)).toEqual(['price']);
  const [stale]=await readListingEvidence(db,{...scope,asins:[asin],asOf:at(10),maxAgeMs:86400000});expect(stale?.availability).toBe('stale');
  const [absent]=await readListingEvidence(db,{...scope,asins:['B000000099'],asOf:at(10),maxAgeMs:86400000});
  expect(absent?.availability).toBe('absent');
});
it('isolates scope and blocks authenticated collector writes',async()=>{
  await expect(persistListingSnapshots(db,foreign,[listing(1,1)],derive)).rejects.toThrow('Cross-profile');
  await expect(persistListingSnapshots(db,{...scope,marketplace:'DE'},[{...listing(1,1),scope:{...scope,marketplace:'DE'}}],derive)).rejects.toThrow('mismatched');
  const rows=await asUser(db,outsider,(sql)=>sql`select id from public.own_listing_observations where org_id=${scope.orgId}`);expect(rows).toHaveLength(0);
  await expect(asUser(db,owner,(sql)=>sql`insert into public.own_listing_observations select * from public.own_listing_observations limit 1`)).rejects.toThrow('permission');
});
it('keeps bid evidence separate from suggested bands and replays without new days',async()=>{
  const before=await db.sql`select * from public.bid_series_daily where org_id=${scope.orgId}`;
  const provenance={source:'synthetic',sourceIdentity:'k',observedAt:at(2),collectedAt:at(3)};
  const bid:EffectiveBidObservation={scope,sourceIdentity:'bid-two',campaignId,adGroupId,targetId:'own-fixture-keyword',targetKind:'keyword',observedAt:at(2),collectedAt:at(3),bid:{value:2,provenance},bidOrigin:'explicit',bidding:null,placementProvenance:null,audienceProvenance:null};
  const first=await persistEffectiveBidObservations(db,scope,[bid]);expect(first.inserted).toBe(1);
  expect(await persistEffectiveBidObservations(db,scope,[{...bid,collectedAt:at(9)}])).toMatchObject({inserted:0,alreadyPresent:1,observedAt:at(2)});
  const stored=await readEffectiveBidObservations(db,{...scope,targetId:bid.targetId,from:'2026-06-01',to:'2026-06-10'});expect(stored.observations).toHaveLength(1);expect(stored.observations[0]).toEqual(bid);
  expect(await db.sql`select * from public.bid_series_daily where org_id=${scope.orgId}`).toEqual(before);
});
it('imports scheduled prompts atomically, rejects cross-profile/conflicting imports, and preserves visits',async()=>{
  const [row]=await db.sql<{id:string}[]>`insert into public.collector_export_references(org_id,profile_id,marketplace,family,enabled,object_key) values(${scope.orgId},${scope.profileId},'US','prompts',true,'prompts.json') returning id`;
  const ref:StoredCollectorExport={id:row!.id,scope,family:'prompts',enabled:true,objectKey:'prompts.json'};
  const input={profileId:scope.profileId,metricSemantics:'disjoint_interval_deltas' as const,rows:[{adProduct:'SP' as const,campaignId,adGroupId,promptText:'Synthetic scheduled prompt',observedAt:at(3),status:'live' as const,intervalStart:at(2),intervalEnd:at(3),spend:1,clicks:1,sales:2,orders:1}]};
  const fingerprint=createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const visits=await db.sql`select * from public.sponsored_prompt_visits where org_id=${scope.orgId}`;
  const first=await importScheduledPrompts(db,ref,fingerprint,input,at(4));expect(first).toMatchObject({inserted:1,alreadyPresent:0,observedAt:at(3)});
  expect(await importScheduledPrompts(db,ref,fingerprint,input,at(9))).toMatchObject({inserted:0,alreadyPresent:1,observedAt:at(3)});
  expect(await db.sql`select * from public.sponsored_prompt_visits where org_id=${scope.orgId}`).toEqual(visits);
  const snapshot=await readSponsoredPrompts(db,{...scope,userId:owner});expect(snapshot.scheduledImports).toEqual([{referenceId:ref.id,observedAt:at(3),collectedAt:at(4)}]);
  await expect(importScheduledPrompts(db,ref,fingerprint,{...input,profileId:foreign.profileId},at(9))).rejects.toThrow('authority');
  await expect(importScheduledPrompts(db,ref,fingerprint,{...input,rows:[{...input.rows[0]!,spend:7}]},at(9))).rejects.toThrow('different values');
});

it('retains product targets and evidenced inherited defaults with individual source times',async()=>{
  await db.sql`update public.ad_groups set default_bid=4,synced_at=${at(6)} where org_id=${scope.orgId} and profile_id=${scope.profileId} and amazon_id=${adGroupId}`;
  await db.sql`update public.keywords set bid=null,bid_observed_at=null,synced_at=${at(6)} where org_id=${scope.orgId} and profile_id=${scope.profileId} and ad_group_id=${adGroupId}`;
  const rows=await readOwnBidMirrors(db,scope,new Date().toISOString());
  const inherited=rows.filter((r)=>r.targetKind==='keyword'&&r.adGroupId===adGroupId);
  expect(inherited.length).toBeGreaterThan(0);
  expect(inherited.every((r)=>r.bidOrigin==='inherited'&&r.bid?.value===4&&r.inheritance?.targetBidAbsentAt===at(6))).toBe(true);
  expect(rows.some((r)=>r.targetKind==='target'&&r.bidOrigin==='explicit')).toBe(true);
  expect(new Set(rows.map((r)=>[r.targetKind,r.targetId].join(':'))).size).toBe(rows.length);
});
it('keeps same-ASIN marketplaces separate and marks only supplied eligibility fields measured',async()=>{
  const [other]=await db.sql<{id:string}[]>`insert into public.ad_profiles(org_id,amazon_profile_id,region,country_code,currency_code,timezone,sync_enabled)
    values(${scope.orgId},'synthetic-own-second','EU','DE','EUR','Europe/Berlin',true) returning id`;
  await db.sql`insert into public.product_ads(org_id,profile_id,amazon_id,ad_product,state,campaign_id,ad_group_id,asin)
    values(${scope.orgId},${other!.id},'synthetic-own-product','SP','enabled','synthetic-campaign','synthetic-group',${asin})`;
  const [unobserved]=await readListingEvidence(db,{orgId:scope.orgId,profileId:other!.id,asins:[asin],asOf:at(10),maxAgeMs:86400000});
  expect(unobserved).toMatchObject({availability:'absent',fields:[],scope:{marketplace:'DE'}});
  const base=listing(8,4);
  await persistListingSnapshots(db,scope,[{...base,fields:[...base.fields,
    {field:'inStock',value:false,provenance:base.fields[0]!.provenance},
    {field:'ownsBuyBox',value:false,provenance:base.fields[0]!.provenance},
    {field:'suppressed',value:true,provenance:base.fields[0]!.provenance}]}],derive);
  const [measured]=await readListingEvidence(db,{...scope,asins:[asin],asOf:at(8),maxAgeMs:86400000});
  expect(measured?.availability).toBe('measured');expect(measured?.moderation).toBe('unavailable');
  expect(measured?.fields.find((f)=>f.observation.field==='inStock')?.observation.value).toBe(false);
});
it('retains saved listing certainty and counts a linked application once on Timeline',async()=>{
  const before=await readTimeline(db,scope.orgId,scope.profileId);
  const changes=await readListingChanges(db,{...scope,from:'1970-01-01',to:'9999-12-31'});
  expect(before.events.filter((event)=>event.id.startsWith('listing:')).map((event)=>[event.id,event.certainty]))
    .toEqual(changes.map((change)=>[`listing:${change.id}`,change.certainty]));
  const [batch]=await db.sql<{id:string}[]>`insert into public.apply_batches(org_id,profile_id,tag,opt_group,lever,note,status,applied_on)
    values(${scope.orgId},${scope.profileId},'Synthetic own bid','Synthetic group','bid','Observed application','applied','2026-06-09') returning id`;
  const bids=await db.sql<{id:string;apply_batch_id:string|null}[]>`insert into public.entity_changes(org_id,profile_id,entity_type,amazon_id,field,old_value,new_value,source,apply_batch_id,observed_at)
    values(${scope.orgId},${scope.profileId},'keyword','synthetic-independent','bid','1','2','sync',null,${at(9)}),
      (${scope.orgId},${scope.profileId},'keyword','synthetic-linked','bid','1','2','sync',${batch!.id},${at(9)}) returning id::text,apply_batch_id`;
  const after=await readTimeline(db,scope.orgId,scope.profileId);
  expect(after.events).toHaveLength(before.events.length+2);
  expect(after.events.some((event)=>event.id===batch!.id)).toBe(true);
  for(const bid of bids)expect(after.events.some((event)=>event.id===`bid:${bid.id}`)).toBe(bid.apply_batch_id===null);
  expect(new Set(after.events.map((event)=>event.id)).size).toBe(after.events.length);
});
