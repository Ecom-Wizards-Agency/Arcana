import { expect, it } from 'vitest';
import { deriveProductAssignment } from './product-assignment.js';
import type { ProductAssignmentEvidence } from '@wizard-ads/shared';
const a = 'B000000001', b = 'B000000002', parent = 'B000000099';
const ad = (asin: string | null, state: 'enabled' | 'paused' | 'archived' = 'enabled', parentAsin: string | null = null) => ({asin,sku:asin,state,parentAsin});
const run = (ads: ProductAssignmentEvidence['ads'], spend: ProductAssignmentEvidence['spend'] = [], matureDays = spend.length ? 30 : 0) =>
  deriveProductAssignment({adGroupId:'group',ads,spend,matureDays,windowDays:30});
it('derives one distinct product, deduplicates SKUs, includes paused and excludes archived', () => {
  const result = run([ad(a,'paused'),ad(a),ad(b,'archived')]);
  expect(result).toMatchObject({source:'derived',assignedAsin:a,ambiguous:false});
  expect(result.candidates).toHaveLength(1);
});
it('derives the shared parent only with unanimous evidence', () => {
  expect(run([ad(a,'enabled',parent),ad(b,'paused',parent)])).toMatchObject({source:'derived_parent',assignedAsin:parent});
  expect(run([ad(a,'enabled',parent),ad(b)])).toMatchObject({source:'proposed',ambiguous:true});
  expect(run([ad(a,'enabled',parent),ad(a),ad(b,'paused',parent)]).source).toBe('proposed');
});
it('proposes the highest-spend product while retaining every ambiguous candidate', () => {
  const result = run([ad(a),ad(b)], [{asin:a,spend:5},{asin:b,spend:20}]);
  expect(result).toMatchObject({source:'proposed',assignedAsin:b,ambiguous:true,reason:'Products do not share a known parent; ranked on 30 of 30 mature days.'});
  expect(result.candidates).toHaveLength(2);
});
it('ranks on the mature days that exist and states their count', () => {
  const result = run([ad(a),ad(b)], [{asin:a,spend:9},{asin:b,spend:3}], 23);
  expect(result).toMatchObject({assignedAsin:a,reason:'Products do not share a known parent; ranked on 23 of 30 mature days.'});
  expect(run([ad(a),ad(b)], [{asin:b,spend:3}], 23).reason).toBe('Products do not share a known parent; ranked on 23 of 30 mature days; spend is unmeasured for 1 product.');
});
it('breaks ties by ASIN and falls back to ASIN order only without a mature day', () => {
  expect(run([ad(b),ad(a)], [{asin:a,spend:0},{asin:b,spend:0}]).assignedAsin).toBe(a);
  const result = run([ad(b),ad(a)]);
  expect(result.assignedAsin).toBe(a);
  expect(result.candidates.every((candidate) => candidate.spend === null)).toBe(true);
  expect(result.reason).toBe('Products do not share a known parent; mature product spend is unavailable.');
});
it('reports unassigned with a reason when no product is identifiable', () => {
  for (const ads of [[],[ad(a,'archived')],[ad(null)]]) expect(run(ads)).toMatchObject({source:'unassigned',assignedAsin:null,ambiguous:false,reason:expect.any(String)});
});
it('does not ignore unidentified ads or mutate its input', () => {
  const input = {adGroupId:'group',ads:[ad(a),ad(null)],spend:[],matureDays:0,windowDays:30};
  const before = structuredClone(input);
  expect(deriveProductAssignment(input)).toMatchObject({source:'proposed',reason:'Some product ads have no identifiable ASIN; mature product spend is unavailable.'});
  expect(input).toEqual(before);
  expect(deriveProductAssignment(input)).toEqual(deriveProductAssignment(input));
});
