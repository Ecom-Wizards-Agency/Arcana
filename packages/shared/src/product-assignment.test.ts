import { expect, it } from 'vitest';
import { ProductAssignmentDerivation, ProductAssignmentEvidence, ProductAssignmentMutation, ProductAssignmentList, ProductAssignmentScope } from './product-assignment.js';
const profileId = '00000000-0000-4000-8000-000000000001';
it('rejects contradictory outcomes and forged actor fields', () => {
  expect(ProductAssignmentDerivation.safeParse({adGroupId:'group', assignedAsin:null,source:'proposed',ambiguous:true,reason:null,candidates:[]}).success).toBe(false);
  expect(ProductAssignmentMutation.safeParse({action:'revert',profileId,adGroupId:'group',assignedBy:'forged'}).success).toBe(false);
  expect(ProductAssignmentMutation.safeParse({action:'assign',profileId,adGroupId:'group',asin:'B000000001',assignedBy:profileId}).success).toBe(false);
});
it('validates the scope dates and their order', () => {
  expect(ProductAssignmentScope.safeParse({ profileId, start: '2026-02-30', end: '2026-03-01' }).success).toBe(false);
  expect(ProductAssignmentScope.safeParse({ profileId, start: '2026-03-02', end: '2026-03-01' }).success).toBe(false);
  expect(ProductAssignmentScope.safeParse({ profileId, start: '2026-03-01', end: '2026-03-01' }).success).toBe(true);
});
it('refuses product spend without a counted mature day', () => {
  const evidence = { adGroupId: 'group', ads: [], spend: [{ asin: 'B000000001', spend: 1 }], matureDays: 1, windowDays: 30 };
  expect(ProductAssignmentEvidence.safeParse(evidence).success).toBe(true);
  expect(ProductAssignmentEvidence.safeParse({ ...evidence, matureDays: 0 }).success).toBe(false);
  expect(ProductAssignmentEvidence.safeParse({ ...evidence, matureDays: 31 }).success).toBe(false);
});
it('counts derived unassigned groups even when their spend is unmeasured, but not groups awaiting a first derivation', () => {
  const item = {adGroupId:'group',campaignId:'campaign',name:null,asins:[],assignedAsin:null,source:'unassigned',derivedAt:'2026-09-01T00:00:00.000Z',derived:{asin:null,source:'unassigned'},ambiguous:false,reason:'No product ads',candidates:[],spend:null};
  const list = {profileId,start:'2026-09-01',end:'2026-09-01',days:1,canAssign:true,items:[item],count:1,unassignedCount:1,unassignedSpend:0};
  expect(ProductAssignmentList.parse(list).count).toBe(1);
  expect(ProductAssignmentList.safeParse({...list,unassignedCount:0}).success).toBe(false);
  const awaiting = {...item,derivedAt:null,derived:null,reason:null,spend:12};
  expect(ProductAssignmentList.safeParse({...list,items:[awaiting],unassignedCount:0}).success).toBe(true);
  expect(ProductAssignmentList.safeParse({...list,items:[awaiting],unassignedCount:1,unassignedSpend:12}).success).toBe(false);
});
it('keeps the saved derivation beside a manual choice and rejects a derived row that disagrees with it', () => {
  const base = {profileId,start:'2026-09-01',end:'2026-09-01',days:1,canAssign:true,count:1,unassignedCount:0,unassignedSpend:0};
  const row = {adGroupId:'group',campaignId:'campaign',name:null,asins:['B000000001','B000000002'],derivedAt:'2026-09-01T00:00:00.000Z',ambiguous:false,reason:null,candidates:[],spend:null};
  const manual = {...row,assignedAsin:'B000000002',source:'manual',derived:{asin:'B000000099',source:'derived_parent'}};
  expect(ProductAssignmentList.parse({...base,items:[manual]}).items[0]?.derived).toEqual({asin:'B000000099',source:'derived_parent'});
  expect(ProductAssignmentList.safeParse({...base,items:[{...manual,source:'derived_parent'}]}).success).toBe(false);
  expect(ProductAssignmentList.safeParse({...base,items:[{...manual,derived:{asin:null,source:'derived'}}]}).success).toBe(false);
});
