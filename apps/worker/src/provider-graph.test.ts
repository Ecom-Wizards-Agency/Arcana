import { describe, expect, it, vi } from 'vitest';
import type { ProviderGraphIntakeReceipt, ProviderGraphReadResult } from '@wizard-ads/shared';
import { collectProviderGraph } from './provider-graph.js';
const scope = { orgId:'00000000-0000-4000-8000-000000000001',profileId:'00000000-0000-4000-8000-000000000002',amazonProfileId:'synthetic',region:'NA' as const };
const at = '2026-09-15T00:00:00Z';
const result: ProviderGraphReadResult = { observations:[],associations:[],sourceRows:0,parsed:0,refusals:[],pages:1,completeness:'complete' };
const counts = { source:0,parsed:0,refused:0,duplicates:0,canonical:0,stored:0,existing:0,verified:0 };
const receipt: ProviderGraphIntakeReceipt = { observations:counts,associations:counts };
const setup = () => ({ scope,resource:'sd_ads' as const,observedAt:at,
  provider:{ read:vi.fn(async () => result) },store:{ append:vi.fn(async () => receipt),
    read:vi.fn(async () => ({ observations:[],associations:[],persistedObservations:0,persistedAssociations:0 })),
    resolve:vi.fn(async () => ({offered:0,verified:0})),publishCoverage:vi.fn(async () => ({})) } });
describe('graph worker collection boundary', () => {
  it('defaults off before any provider or persistence call', async () => {
    const input=setup(); expect(await collectProviderGraph(input)).toEqual({state:'disabled'});
    expect(input.provider.read).not.toHaveBeenCalled(); expect(input.store.append).not.toHaveBeenCalled();
  });
  it('distinguishes an empty complete read from no execution', async () => {
    const input=setup(); expect(await collectProviderGraph({...input,enabled:true})).toMatchObject({state:'collected',completeness:'complete'});
    expect(input.store.append).toHaveBeenCalledOnce(); expect(input.store.read).toHaveBeenCalledOnce(); expect(input.store.resolve).toHaveBeenCalledWith(scope,[],{ observations:[],associations:[],persistedObservations:0,persistedAssociations:0 },at);
    expect(input.store.publishCoverage).toHaveBeenCalledWith(expect.objectContaining({
      status:'complete',sourceRows:0,loadedRows:0,observedAt:at }),0);
  });
  it('stops projection when persistence lies about row accounting', async () => {
    const input=setup(); input.provider.read.mockResolvedValue({...result,sourceRows:1,refusals:[{index:0,reason:'invalid_row'}],completeness:'partial'});
    await expect(collectProviderGraph({...input,enabled:true})).rejects.toThrow('receipt');
    expect(input.store.read).not.toHaveBeenCalled(); expect(input.store.resolve).not.toHaveBeenCalled();
    expect(input.store.publishCoverage).not.toHaveBeenCalled();
  });
});
