import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { AssetRegistrationIntent } from '@wizard-ads/shared';
import { createTestDatabase, type TestDatabase } from '@wizard-ads/db/testing';
import { withAuthenticatedOrgEditor, admitAssetRegistration, reserveAssetRegistration, reconcileAssetRegistrations } from '@wizard-ads/db';
import { assetRegistrationFingerprint, executeAssetRegistration, reconcileUncertainAssetRegistrations } from './asset-registration.js';
import { reconcileEvidenceOnWorkerStart } from './evidence-reconciliation.js';
let db: TestDatabase;
const actor = {orgId:randomUUID(),userId:randomUUID()};
const profileId=randomUUID();
const bytes=Uint8Array.from([137,80,78,71,13,10,26,10]);
function request() { return AssetRegistrationIntent.parse({id:randomUUID(),authorityId:randomUUID(),profileId,
  scope:{region:'EU',amazonProfileId:'313'},manifest:{fileName:'synthetic.png',contentType:'image/png',byteLength:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')},
  registration:{name:'Synthetic asset',assetType:'IMAGE',assetSubTypes:['PRODUCT_IMAGE']}}); }
async function authority(r:AssetRegistrationIntent, enabled=true) {
  await db.sql`insert into public.asset_registration_authorities(id,org_id,profile_id,actor_id,request,enabled,expires_at)
    values(${r.authorityId},${actor.orgId},${profileId},${actor.userId},${JSON.stringify(r)}::jsonb,${enabled},now()+interval '1 hour')`;
}
async function admit(r:AssetRegistrationIntent) { return withAuthenticatedOrgEditor(db,actor,(tx)=>admitAssetRegistration(tx,r)); }
beforeAll(async()=>{
  db=await createTestDatabase('wp313_asset_admission');
  await db.sql`insert into auth.users(id) values(${actor.userId})`;
  await db.sql`insert into public.orgs(id,slug,name) values(${actor.orgId},${'asset-'+actor.orgId},'Synthetic asset admission')`;
  await db.sql`insert into public.org_members(org_id,user_id,role) values(${actor.orgId},${actor.userId},'owner')`;
  await db.sql`insert into public.ad_profiles(id,org_id,amazon_profile_id,region,country_code,currency_code,timezone)
    values(${profileId},${actor.orgId},'313','EU','DE','EUR','UTC')`;
},120000);
afterAll(async()=>{await db?.drop();});
it('refuses absent/off/expired/mismatched authority and preserves exact-input admission',async()=>{
  const r=request();expect((await admit(r)).refusal).toBe('authority_missing');
  await authority(r,false);expect((await admit(r)).refusal).toBe('disabled');
  await db.sql`update public.asset_registration_authorities set enabled=true,expires_at=now()-interval '1 second' where id=${r.authorityId}`;
  expect((await admit(r)).refusal).toBe('authority_expired');
  await db.sql`update public.asset_registration_authorities set expires_at=now()+interval '1 hour' where id=${r.authorityId}`;
  expect((await admit({...r,manifest:{...r.manifest,byteLength:9}})).refusal).toBe('manifest_mismatch');
  expect(await admit(r)).toMatchObject({requested:1,admittedCount:1,refused:0});
  expect(await admit(r)).toMatchObject({requested:1,admittedCount:1,refused:0});
  expect(await db.sql`select id from public.asset_registration_intents where id=${r.id}`).toHaveLength(1);
  const invalid={...request(),registration:{...r.registration,assetType:'VIDEO' as const,assetSubTypes:['BACKGROUND_VIDEO' as const]}};
  await authority(invalid);expect((await admit(invalid)).refusal).toBe('invalid_media');
  expect(await db.sql`select id from public.asset_registration_intents where id=${invalid.id}`).toHaveLength(0);
});
it('never calls a provider while off; accepts once and enqueues the existing search consumer once',async()=>{
  const r=request();await authority(r);await admit(r);
  const provider={scope:r.scope,upload:vi.fn(async()=>({kind:'uploaded' as const,content:{manifest:r.manifest}})),
    register:vi.fn(async()=>({kind:'accepted' as const,scope:r.scope,identity:{assetId:'asset-fixture',version:'1'},failedSpecChecks:null}))};
  expect(await executeAssetRegistration({handle:db,request:r,bytes,provider})).toMatchObject({requested:1,attempted:0,refused:1});
  expect(provider.upload).not.toHaveBeenCalled();
  expect(await executeAssetRegistration({handle:db,request:r,bytes:Uint8Array.from([0]),provider,enabled:true})).toMatchObject({attempted:0,refused:1,reason:'invalid_media'});
  expect(await executeAssetRegistration({handle:db,request:r,bytes,provider:{...provider,scope:{...r.scope,amazonProfileId:'other'}},enabled:true})).toMatchObject({attempted:0,refused:1,reason:'scope_mismatch'});
  expect(provider.upload).not.toHaveBeenCalled();
  expect(await executeAssetRegistration({handle:db,request:r,bytes,provider,enabled:true})).toMatchObject({requested:1,attempted:1,succeeded:1,failed:0,refused:0});
  expect(await executeAssetRegistration({handle:db,request:r,bytes,provider,enabled:true})).toMatchObject({attempted:0,refused:1});
  expect(provider.upload).toHaveBeenCalledTimes(1);expect(provider.register).toHaveBeenCalledTimes(1);
  expect(await db.sql`select id from public.sync_jobs where dedupe_key=${'asset-registration:'+r.id} and job_type='asset-library.search'`).toHaveLength(1);
  await expect(db.sql`update public.asset_registration_intents set request='{}'::jsonb where id=${r.id}`).rejects.toThrow('immutable');
});
it('restart quarantines an interrupted reservation; exact read-only reconciliation loads one identity',async()=>{
  const r=request();await authority(r);await admit(r);expect((await reserveAssetRegistration(db,r.id,true)).request).not.toBeNull();
  await db.sql`update public.asset_registration_intents set attempted_at=now()-interval '31 minutes' where id=${r.id}`;
  expect(await reconcileAssetRegistrations(db)).toMatchObject({requested:0});
  expect(await reconcileEvidenceOnWorkerStart(db,{streamEnabled:false,assetEnabled:true})).toMatchObject({assets:{requested:1,attempted:1,succeeded:1,failed:0,refused:0}});
  expect((await reserveAssetRegistration(db,r.id,true)).refusal).toBe('already_reserved');
  const resolve=vi.fn(async()=>({intentId:r.id,requestFingerprint:assetRegistrationFingerprint(r),scope:r.scope,identity:{assetId:'reconciled-asset',version:'1'}}));
  expect(await reconcileUncertainAssetRegistrations({handle:db,enabled:true,resolve})).toEqual({requested:1,attempted:1,succeeded:1,failed:0,refused:0});
  expect(await reconcileUncertainAssetRegistrations({handle:db,enabled:true,resolve})).toMatchObject({requested:0});
  expect(resolve).toHaveBeenCalledTimes(1);
  expect(await db.sql`select id from public.sync_jobs where dedupe_key=${'asset-registration:'+r.id}`).toHaveLength(1);
});
it('revoked membership prevents reserving an admitted write',async()=>{
  const r=request();await authority(r);await admit(r);
  await db.sql`update public.org_members set role='viewer' where org_id=${actor.orgId} and user_id=${actor.userId}`;
  expect((await reserveAssetRegistration(db,r.id,true)).refusal).toBe('unauthorized_actor');
});
