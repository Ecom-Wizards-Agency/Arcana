import { expect, it } from 'vitest';
import { SpReportAdmission, SpReportAdmissionCode } from './spapi-reports.js';
import { ReportCoverageObservation } from './reporting.js';

it('validates every stable report admission refusal code and rejects unclassified refusals',()=>{
  expect(SpReportAdmissionCode.options).toHaveLength(9);
  for(const code of SpReportAdmissionCode.options)expect(SpReportAdmission.parse({admitted:false,code})).toEqual({admitted:false,code});
  expect(SpReportAdmission.safeParse({admitted:false,code:'unknown'}).success).toBe(false);
  expect(SpReportAdmission.safeParse({admitted:true}).success).toBe(false);
});
it('requires a verified coverage boundary to lie within the producer period',()=>{
  const observation={orgId:'11111111-1111-4111-8111-111111111111',profileId:'22222222-2222-4222-8222-222222222222',
    source:'amazon_spapi',reportType:'synthetic',grain:'weekly',status:'complete',earliestDate:'2026-09-06',coveredThrough:'2026-09-12',
    observedAt:'2026-09-13T00:00:00.000Z',settledThrough:null,sourceRows:1,parsedRows:1,loadedRows:1,refusedRows:0,countsMatch:true};
  expect(ReportCoverageObservation.parse({...observation,verifiedStartDate:'2026-09-06'}).verifiedStartDate).toBe('2026-09-06');
  for(const verifiedStartDate of ['2026-09-05','2026-09-13'])expect(ReportCoverageObservation.safeParse({...observation,verifiedStartDate}).success).toBe(false);
});
