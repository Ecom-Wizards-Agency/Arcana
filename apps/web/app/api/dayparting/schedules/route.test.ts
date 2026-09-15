import {beforeAll,afterAll,expect,it,vi} from 'vitest';
import {createTestDatabase,type TestDatabase} from '@wizard-ads/db/testing';
import {GET,POST} from './route';
import {POST as review} from './review/route';
const actor='26600000-0000-4000-8000-000000000001';
let database:TestDatabase,orgId:string,profileId:string;
beforeAll(async()=>{
  database=await createTestDatabase('wp266_schedule_routes');
  const [org]=await database.sql<{id:string}[]>`select app.seed_tenant_fixture('schedule-route-fixture',${actor},'admin') as id`;
  orgId=org!.id;
  const [profile]=await database.sql<{id:string}[]>`select id from public.ad_profiles where org_id=${orgId} limit 1`;
  profileId=profile!.id;
  vi.stubEnv('DATABASE_URL',database.connectionString);
  vi.stubEnv('WIZARD_ADS_E2E_AUTH_BRIDGE','1');
  vi.stubEnv('WIZARD_ADS_AUTH_BRIDGE_SECRET','synthetic-schedule-bridge');
},120000);
afterAll(async()=>{vi.unstubAllEnvs();await database?.drop();});
function request(body?:unknown){
  return new Request(`http://localhost/api/dayparting/schedules?profileId=${profileId}`,{
    method:body===undefined?'GET':'POST',
    headers:{'content-type':'application/json','x-wizard-ads-auth-bridge':'synthetic-schedule-bridge','x-wizard-ads-user-id':actor,'x-wizard-ads-org-id':orgId},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),
  });
}
it('saves and edits exactly 168 JSON cells through the authenticated HTTP boundary',async()=>{
  const modifiers=Array.from({length:7},()=>Array<number>(24).fill(0));modifiers[1]![17]=37;
  const created=await POST(request({profileId,name:'Synthetic HTTP schedule',modifiers,campaignIds:['c-1'],sourceProposalId:null}));
  expect(created.status).toBe(201);
  const {schedule}=await created.json();
  modifiers[0]![6]=-23;
  const edited=await POST(request({profileId,id:schedule.id,expectedUpdatedAt:schedule.updatedAt,name:schedule.name,modifiers,campaignIds:['c-1'],sourceProposalId:null}));
  expect(edited.status).toBe(201);
  const result=await edited.json();expect(result.schedule.modifiers).toEqual(modifiers);expect(result.schedule.modifiers.flat()).toHaveLength(168);
  const response=await GET(request());const read=await response.json();expect(read.count).toBe(2);expect(read.schedules).toHaveLength(read.count);
});
it('refuses execution states on both mutation routes without altering a saved draft',async()=>{
  const {schedules}=await (await GET(request())).json();const schedule=schedules[0];
  for(const status of ['enabled','paused']){
    expect((await POST(request({profileId,id:schedule.id,expectedUpdatedAt:schedule.updatedAt,name:schedule.name,modifiers:schedule.modifiers,campaignIds:schedule.campaignIds,sourceProposalId:null,status}))).status).toBe(400);
    expect((await review(request({profileId,id:schedule.id,expectedUpdatedAt:schedule.updatedAt,evidenceStart:'2026-06-01',evidenceEnd:'2026-06-07',evidenceFingerprint:'a'.repeat(64),status}))).status).toBe(400);
  }
  const read=await (await GET(request())).json();expect(read.schedules).toHaveLength(2);expect(read.schedules.every((s:{status:string})=>s.status==='draft')).toBe(true);
});
