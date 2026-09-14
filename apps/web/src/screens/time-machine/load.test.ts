import { expect, it, vi } from 'vitest';
import { ChangeQueueRestoreBatchPreview, COORDINATED_RESTORE_UNAVAILABLE } from '@wizard-ads/shared';
import type { ScreenActor } from '../../server/page-read';
import { context, profile as baseProfile } from '../synthetic-render-fixtures';
const mocks=vi.hoisted(()=>({preview:vi.fn(),entries:vi.fn(),profiles:vi.fn(),role:vi.fn()}));
vi.mock('@wizard-ads/db',()=>({getReversionBatchPreview:mocks.preview,listChangeQueue:mocks.entries,readRestoreProposal:vi.fn()}));
vi.mock('../../recommendations/data',()=>({listOrgProfiles:mocks.profiles}));
vi.mock('../../server/org-role',()=>({requireOrgRole:mocks.role}));
vi.mock('../../server/request-context',()=>({authenticationDestination:()=>null}));
import { load } from './load';

it('loads every physical row of one coordinated proposal with the restore refusal reason',async()=>{
  const id='10000000-0000-4000-8000-000000000001';
  const profile={...baseProfile,id:'10000000-0000-4000-8000-000000000005'};
  const row={batchId:id,rowId:id,recommendationId:null,entityType:'keyword',entityId:'synthetic',entityName:null,field:'bid',
    originalValue:1,proposedValue:2,exportedValue:2,synchronizedValue:null,synchronizedAt:null,currentValue:null,currentSyncedAt:null,
    inverseValue:1,state:'unsupported',conflict:false,exportAllowed:false,reason:COORDINATED_RESTORE_UNAVAILABLE};
  const preview=ChangeQueueRestoreBatchPreview.parse({batchId:id,sourceBatchId:null,activeReversionBatchId:null,profileId:profile.id,
    tag:'synthetic',optGroup:'synthetic',lever:'coordinated',note:'',lifecycleStatus:'exported',exportedAt:'2026-09-15T00:00:00Z',
    appliedAt:null,artifactSha256:null,exportedProposals:1,reversibleRows:2,unsupportedRows:0,
    rows:[row,{...row,rowId:'10000000-0000-4000-8000-000000000002'}],readyRows:0,blockedRows:2,
    exportAllowed:false,reason:COORDINATED_RESTORE_UNAVAILABLE,dependencySetCount:1});
  mocks.preview.mockResolvedValue(preview);mocks.entries.mockResolvedValue([]);
  mocks.profiles.mockResolvedValue([profile]);mocks.role.mockResolvedValue('owner');
  const read=vi.fn(async run=>run({sql:vi.fn().mockResolvedValue([{partial:true}])},{orgId:context.active!.orgId,userId:context.user.id}));
  const data=await load({read,selectProfile:()=>profile} as unknown as ScreenActor,{params:{},searchParams:{batch:id,profile:profile.id}});
  expect(data.view).toBe('ready');
  if(data.view!=='ready') throw new Error('Expected a complete restore preview');
  expect(data.props.preview?.rows).toHaveLength(2);
  for(const result of data.props.preview!.rows) expect(result).toMatchObject({state:'unsupported',why:COORDINATED_RESTORE_UNAVAILABLE,now:null});
  expect(read).toHaveBeenCalledTimes(1);
});
