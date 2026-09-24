import { randomUUID } from 'node:crypto';
import { afterAll,beforeAll,expect,it } from 'vitest';
import { appendProviderGraphEvidence } from '@wizard-ads/db';
import { asUser,createTestDatabase,type TestDatabase } from '@wizard-ads/db/testing';
import type { ProviderGraphObservation,ProviderGraphScope } from '@wizard-ads/shared';
import { loadTargetGraphEvidence } from './model';

let db:TestDatabase;let scope:ProviderGraphScope;
const owner=randomUUID(),outsider=randomUUID();
const at='2026-09-15T00:00:00Z';
const args=()=>({scope,targetId:'target-one',adProduct:'SD' as const,targetKind:'product target',asOf:at,maxAgeMs:86400000});
beforeAll(async()=>{
  db=await createTestDatabase('wp313_target_graph',{applyFixture:false});
  const orgId=randomUUID(),profileId=randomUUID();
  await db.sql`insert into auth.users(id) values(${owner}),(${outsider})`;
  await db.sql`insert into public.orgs(id,slug,name) values(${orgId},${'target-graph-'+randomUUID()},'Synthetic target graph')`;
  await db.sql`insert into public.org_members(org_id,user_id,role) values(${orgId},${owner},'owner')`;
  await db.sql`insert into public.ad_profiles(id,org_id,amazon_profile_id,region,country_code,currency_code,timezone)
    values(${profileId},${orgId},'synthetic','EU','DE','EUR','UTC')`;
  scope={orgId,profileId,amazonProfileId:'synthetic',region:'EU'};
  const target:ProviderGraphObservation={scope,identity:{adProduct:'SD',kind:'target',providerId:'target-one',version:null},
    source:'marketing_stream',contractVersion:'fixture.v1',sourceEventAt:at,observedAt:at,revision:'1',
    payloadFingerprint:'a'.repeat(64),operation:'upsert',state:'enabled'};
  const campaign:ProviderGraphObservation={...target,identity:{...target.identity,kind:'campaign',providerId:'campaign-one'}};
  await appendProviderGraphEvidence(db,scope,{observations:[target,campaign],sourceRows:2,parsed:2,refusals:[],pages:1,completeness:'partial',
    associations:[campaign.identity,{...campaign.identity,kind:'ad_group' as const,providerId:'missing-group'}].map((to)=>({scope,from:target.identity,to,
      relation:'parent',sourceEventAt:at,revision:'1',payloadFingerprint:'a'.repeat(64),operation:'upsert'}))});
},120000);
afterAll(async()=>{if(db)await db.drop();});
it('shows one resolved source-labeled association and counts the unverified parent separately',async()=>{
  const result=await asUser(db,owner,(sql)=>loadTargetGraphEvidence({sql},args()));
  expect(result).toMatchObject({status:'partial',unresolvedCount:1});expect(result.rows).toHaveLength(1);
  expect(result.rows[0]).toMatchObject({kind:'campaign',providerId:'campaign-one',source:'marketing_stream',sourceEventAt:at,stale:false});
});
it('keeps product, entity kind and authenticated tenant identities separate',async()=>{
  expect(await asUser(db,owner,(sql)=>loadTargetGraphEvidence({sql},{...args(),adProduct:'SB'}))).toMatchObject({status:'missing',rows:[]});
  expect(await asUser(db,owner,(sql)=>loadTargetGraphEvidence({sql},{...args(),targetKind:'keyword'}))).toMatchObject({status:'missing',rows:[]});
  expect(await asUser(db,outsider,(sql)=>loadTargetGraphEvidence({sql},args()))).toMatchObject({status:'missing',rows:[]});
});
it('labels old associations stale and future observations missing',async()=>{
  expect(await loadTargetGraphEvidence(db,{...args(),asOf:'2026-09-17T00:00:00Z'})).toMatchObject({status:'stale',rows:[{stale:true}]});
  expect(await loadTargetGraphEvidence(db,{...args(),asOf:'2026-09-14T00:00:00Z'})).toMatchObject({status:'missing',rows:[]});
});
