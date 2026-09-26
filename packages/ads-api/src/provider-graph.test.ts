import { describe, expect, it } from 'vitest';
import type { ProviderGraphResource } from '@wizard-ads/shared';
import { PROVIDER_GRAPH_ENDPOINTS, readProviderGraph, type ProviderGraphReadTransport } from './provider-graph.js';

const scope = { orgId: '00000000-0000-4000-8000-000000000001',
  profileId: '00000000-0000-4000-8000-000000000002', amazonProfileId: 'synthetic', region: 'NA' as const };
const observedAt = '2026-09-15T00:00:00Z';
function fake(pages: unknown[]): { transport: ProviderGraphReadTransport; requests: unknown[] } {
  const requests: unknown[] = [];
  return { requests, transport: { read: async (request) => { requests.push(request);
    if (!pages.length) throw new Error('Unexpected provider request'); return pages.shift(); } } };
}
const fixtures: Record<ProviderGraphResource, Record<string, unknown>> = {
  sb_ads: { adId: 'ad-one', campaignId: 'campaign-one', adGroupId: 'group-one', state: 'ENABLED',
    creative: { videoAssetIds: ['amzn1.assetlibrary.asset1.synthetic:version_one'], asins: ['SYNTHASIN1'] } },
  sb_creatives: { adId: 'ad-one', creativeVersion: 'version_one', creativeType: 'VIDEO',
    creativeStatus: 'APPROVED', creativeProperties: {} },
  sd_campaigns_extended: { campaignId: 101, state: 'enabled' },
  sd_ad_groups_extended: { adGroupId: 102, campaignId: 101, state: 'enabled' },
  sd_ads: { adId: 103, adGroupId: 102, campaignId: 101, asin: 'SYNTHASIN1', state: 'enabled' },
  sd_ads_extended: { adId: 103, adGroupId: 102, campaignId: 101, state: 'paused' },
  sd_targets: { targetId: 104, adGroupId: 102, state: 'enabled' },
  sd_targets_extended: { targetId: 104, adGroupId: 102, state: 'enabled' },
  sd_negatives: { targetId: 105, adGroupId: 102, state: 'enabled' },
  sd_negatives_extended: { targetId: 105, adGroupId: 102, state: 'enabled' },
  sd_creatives: { creativeId: 106, adGroupId: 102, creativeType: 'IMAGE', moderationStatus: 'APPROVED',
    properties: { rectCustomImage: { assetId: 'synthetic-asset', assetVersion: 'version_one' } } },
};
describe('product-specific graph read transport, synthetic official-schema subset fixtures', () => {
  for (const resource of Object.keys(fixtures) as ProviderGraphResource[]) {
    it(`counts and parses ${resource}`, async () => {
      const endpoint = PROVIDER_GRAPH_ENDPOINTS[resource];
      const payload = endpoint.key ? { [endpoint.key]: [fixtures[resource]] } : [fixtures[resource]];
      const provider = fake([payload]);
      const result = await readProviderGraph(provider.transport, { scope, resource, observedAt, enabled: true,
        ...(resource === 'sb_creatives' ? { adId: 'ad-one' } : {}) });
      expect(result).toMatchObject({ sourceRows: 1, parsed: 1, pages: 1, refusals: [], completeness: 'complete' });
      expect(result.observations).toHaveLength(1);
      expect(result.observations[0]?.identity).toMatchObject({ kind: endpoint.kind, adProduct: endpoint.product });
      expect(provider.requests).toHaveLength(1);
      expect(provider.requests[0]).toMatchObject({ path: endpoint.path, method: endpoint.product === 'SB' ? 'POST' : 'GET' });
    });
  }
  it('has no transport call by default and refuses missing SB creative parent ID', async () => {
    const provider = fake([]);
    await expect(readProviderGraph(provider.transport, { scope, resource: 'sd_ads', observedAt })).rejects.toThrow('disabled');
    await expect(readProviderGraph(provider.transport, { scope, resource: 'sb_creatives', observedAt, enabled: true })).rejects.toThrow('exact ad ID');
    expect(provider.requests).toHaveLength(0);
  });
  it('counts primitive and identity refusals without dropping source rows', async () => {
    const provider = fake([{ ads: [fixtures.sb_ads, null, {}, { ...fixtures.sb_ads, adId: undefined }] }]);
    const result = await readProviderGraph(provider.transport, { scope, resource: 'sb_ads', observedAt, enabled: true });
    expect(result).toMatchObject({ sourceRows: 4, parsed: 1, completeness: 'partial' });
    expect(result.refusals.map((r) => r.index)).toEqual([1, 2, 3]);
    expect(result.associations).toHaveLength(4);
  });
  it('preserves pagination and scopes SB creative versions to their real ad', async () => {
    const provider = fake([{ creatives: [fixtures.sb_creatives], nextToken: 'page-two' },
      { creatives: [{ ...fixtures.sb_creatives, adId: 'another-ad' }] }]);
    const result = await readProviderGraph(provider.transport, { scope, resource: 'sb_creatives', adId: 'ad-one', observedAt, enabled: true });
    expect(result).toMatchObject({ pages: 2, sourceRows: 2, parsed: 1, completeness: 'partial' });
    expect(result.refusals).toEqual([{ index: 1, reason: 'wrong_ad' }]);
    expect(result.observations[0]?.identity).toMatchObject({ providerId: 'ad-one', version: 'version_one' });
    expect(provider.requests[1]).toMatchObject({ body: { adId: 'ad-one', nextToken: 'page-two' } });
  });
  it('keeps capped inventories partial and detects repeated continuation tokens', async () => {
    const capped = fake([[fixtures.sd_ads]]);
    const result = await readProviderGraph(capped.transport, { scope, resource: 'sd_ads', observedAt, enabled: true, pageSize: 1, maxPages: 1 });
    expect(result.completeness).toBe('partial');
    const repeated = fake([{ ads: [], nextToken: 'repeated' }, { ads: [], nextToken: 'repeated' }]);
    await expect(readProviderGraph(repeated.transport, { scope, resource: 'sb_ads', observedAt, enabled: true })).rejects.toThrow('continuation');
  });
  it('never promotes approval or temporary URLs into durable serving permission', async () => {
    const provider = fake([[{ ...fixtures.sd_creatives, previewUrl: 'https://example.invalid/transient' }]]);
    const result = await readProviderGraph(provider.transport, { scope, resource: 'sd_creatives', observedAt, enabled: true });
    expect(result.observations[0]?.state).toBe('unknown');
    expect(JSON.stringify(result)).not.toContain('transient');
    expect(JSON.stringify(result)).not.toContain('APPROVED');
    expect(result.associations.find((e) => e.relation === 'asset')?.to).toMatchObject({ providerId: 'synthetic-asset', version: 'version_one' });
  });
  it('refuses unsafe numeric identities and schema drift', async () => {
    const provider = fake([[{ ...fixtures.sd_ads, adId: Number.MAX_SAFE_INTEGER + 1 }]]);
    const result = await readProviderGraph(provider.transport, { scope, resource: 'sd_ads', observedAt, enabled: true });
    expect(result.refusals).toHaveLength(1);
    await expect(readProviderGraph(fake([{ entities: [] }]).transport,
      { scope, resource: 'sd_ads', observedAt, enabled: true })).rejects.toThrow('entity array');
  });
});
