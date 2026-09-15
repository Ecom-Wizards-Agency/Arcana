import { describe, expect, it, vi } from 'vitest';
import type { CollectorReceipt, JobPayload } from '@wizard-ads/shared';
import type { ClaimedJob } from '@wizard-ads/db';
import { IngestionRegistry } from '../ingestion-registry.js';
import { ingestionLaneJobTypes } from '../ingestion-sources.js';
import { PermanentJobError } from '../permanent-job-error.js';
import { registerOwnCollectors } from './index.js';
import { scopedKeepaListing } from './keepa.js';
const orgId='00000000-0000-4000-8000-000000000001',profileId='00000000-0000-4000-8000-000000000002';
const at='2026-09-01T12:00:00.000Z';
const receipt: CollectorReceipt={ counts:{sourceRows:1,parsedRows:1,refusedRows:0,loadedRows:1,verifiedLoadedRows:1},inserted:1,alreadyPresent:0,outputIdentities:['one'],observedAt:at,state:'measured' };
for (const type of ['own_bids.collect','own_listings.collect','prompts.collect'] as const) describe(type,()=>{
  const context=()=> { const payload:JobPayload={type,orgId,profileId};return { payload,job:{id:orgId,orgId,profileId,jobType:type,payload,attempts:1,maxAttempts:3,dedupeKey:null,claim:null,claimedBy:'synthetic'} as ClaimedJob,profile:{id:profileId,orgId,amazonProfileId:'synthetic',region:'NA' as const,currencyCode:'USD',timezone:'UTC'} }; };
  it('dispatches exact identities and source-time coverage',async()=>{
    const producer=vi.fn(async()=>({offered:1,written:1,unchanged:0})); const registry=new IngestionRegistry(producer);
    registerOwnCollectors(registry,{now:()=>new Date(at),collect:async()=>receipt});
    expect(await registry.dispatch(context())).toEqual({receipt});
    expect(producer).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({status:'complete',observedAt:at,loadedRows:1}),1);
  });
  it.each(['disabled','unconfigured','missing'] as const)('does not freshen %s evidence',async(state)=>{
    const producer=vi.fn(async()=>({offered:1,written:1,unchanged:0}));const registry=new IngestionRegistry(producer);
    registerOwnCollectors(registry,{now:()=>new Date(at),collect:async()=>({...receipt,state,observedAt:null,outputIdentities:[],inserted:0,counts:{sourceRows:0,parsedRows:0,refusedRows:0,loadedRows:0,verifiedLoadedRows:0}})});
    await registry.dispatch(context()); expect(producer).toHaveBeenCalledWith(expect.objectContaining({status:'partial',observedAt:'1970-01-01T00:00:00.000Z'}),0);
  });
  it('retains stale replay time, retries failures, and refuses dropped outputs',async()=>{
    const producer=vi.fn(async()=>({offered:1,written:1,unchanged:0})); const registry=new IngestionRegistry(producer);
    const collect=vi.fn().mockRejectedValueOnce(new Error('retry')).mockResolvedValueOnce(receipt).mockResolvedValueOnce({...receipt,outputIdentities:[]}).mockRejectedValueOnce(new PermanentJobError('permanent'));
    registerOwnCollectors(registry,{now:()=>new Date('2026-09-04T00:00:00Z'),collect});
    await expect(registry.dispatch(context())).rejects.toThrow('retry');expect(producer).not.toHaveBeenCalled();
    await registry.dispatch(context());expect(producer).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({status:'partial',observedAt:at}),1);
    await expect(registry.dispatch(context())).rejects.toThrow('Output identities');
    await expect(registry.dispatch(context())).rejects.toThrow(PermanentJobError);expect(producer).toHaveBeenCalledTimes(1);
  });
});
it('adds three integration jobs and preserves report lanes',()=>{
  expect(ingestionLaneJobTypes('integrations')).toEqual(['own_bids.collect','own_listings.collect','prompts.collect','translation.request','keepa.sync','rank.sync','economics.sync','sqp.request']);
  expect(ingestionLaneJobTypes('evo-report')).toEqual(['creative.sync','report.request','report.poll','report.fetch']);
  expect(ingestionLaneJobTypes('evo-report-unified')).toEqual(['creative.sync','report.request','report.poll','report.fetch','report.unified.advance']);
});
it('Keepa preserves field times and never infers stock, ownership or suppression',()=>{
  const snapshot=scopedKeepaListing({orgId,profileId,marketplace:'US'},{asin:'B000000001',category:'synthetic',categoryName:null,updatedAt:null,
    salesRank:[],newPrice:[{observedAt:new Date(at),value:2}],buyBoxPrice:[{observedAt:new Date('2026-08-30T00:00:00Z'),value:3}],rating:[],reviewCount:[],lightningDeal:null,coupon:null},'2026-09-04T00:00:00.000Z');
  expect(snapshot?.fields.map((f)=>[f.field,f.provenance.observedAt])).toEqual([['price',at],['buyBoxPrice','2026-08-30T00:00:00.000Z']]);
});
