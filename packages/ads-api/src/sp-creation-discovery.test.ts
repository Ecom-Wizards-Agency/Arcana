import { describe, expect, it } from 'vitest';
import { discoverSpCreation, spCreationIdentityQuery } from './sp-creation-discovery.js';
import { plan, hasher, id } from './__fixtures__/sp-creation.js';
import type { SpCreationCompiledCall } from './sp-creation-codec.js';

// Compiler tests already prove complete authorization artifacts. These tests exercise the private list boundary.
function call(kind: SpCreationCompiledCall['kind'], item: Record<string, unknown>): SpCreationCompiledCall {
  const keys = { campaigns: 'campaigns', adGroups: 'adGroups', productAds: 'productAds', keywords: 'keywords' };
  return { kind, method: 'POST', path: `/sp/${kind}`, mediaType: 'application/json', body: JSON.stringify({ [keys[kind as keyof typeof keys]]: [item] }),
    providerScope: plan().providerScope, requestDigest: 'a'.repeat(64), positions: [{ requestIndex: 0, nodeId: id(10), nodeFingerprint: 'b'.repeat(64), requestDigest: 'c'.repeat(64) }] };
}
const at = () => Date.parse('2026-09-15T12:00:00.000Z');
async function scan(compiled: SpCreationCompiledCall, pages: unknown[]) {
  const requests: Array<Record<string, unknown>> = [];
  const result = await discoverSpCreation(compiled, null, { now: at, hasher,
    read: async (_path, body) => { requests.push(JSON.parse(body)); return { status: 200, body: new TextEncoder().encode(JSON.stringify(pages[requests.length - 1])) }; } });
  return { result, requests };
}
describe('complete deterministic identity discovery', () => {
  it.each([
    ['campaigns', { name: 'Synthetic campaign' }, { nameFilter: { include: ['Synthetic campaign'], queryTermMatchType: 'EXACT_MATCH' } }],
    ['adGroups', { campaignId: '901', name: 'Synthetic group' }, { campaignIdFilter: { include: ['901'] }, nameFilter: { include: ['Synthetic group'], queryTermMatchType: 'EXACT_MATCH' } }],
    ['productAds', { adGroupId: '902', sku: 'SYNTHETIC-SKU' }, { adGroupIdFilter: { include: ['902'] } }],
    ['keywords', { adGroupId: '902', keywordText: 'synthetic keyword', matchType: 'EXACT' }, { adGroupIdFilter: { include: ['902'] }, keywordTextFilter: { include: ['synthetic keyword'], queryTermMatchType: 'EXACT_MATCH' }, matchTypeFilter: ['EXACT'] }],
  ] as const)('uses the pinned %s identity filters', (kind, item, filters) => {
    expect(spCreationIdentityQuery(call(kind, item), null).body).toMatchObject(filters);
  });
  it('adopts the one exact product identity on a later page and counts every unrelated row', async () => {
    const item = { adGroupId: '902', campaignId: '901', sku: 'SYNTHETIC-SKU', state: 'PAUSED' };
    const result = await scan(call('productAds', item), [
      { productAds: [{ ...item, sku: 'OTHER-SKU', adId: '903' }], nextToken: 'page-two', totalResults: 2 },
      { productAds: [{ ...item, adId: '904' }], totalResults: 2 },
    ]);
    expect(result.requests).toHaveLength(2); expect(result.requests[1]).toHaveProperty('nextToken', 'page-two');
    expect(result.result).toMatchObject({ observation: 'observed', providerEntityId: '904', complete: true,
      accounting: { pages: 2, loaded: 2, parsed: 2, matched: 1 } });
  });
  it('refuses two exact matches across separate pages', async () => {
    const item = { adGroupId: '902', keywordText: 'synthetic keyword', matchType: 'EXACT', state: 'PAUSED', bid: 1 };
    const { result } = await scan(call('keywords', item), [{ keywords: [{ ...item, keywordId: '905' }], nextToken: 'two' }, { keywords: [{ ...item, keywordId: '906' }] }]);
    expect(result).toMatchObject({ observation: 'ambiguous_readback', providerEntityId: null, complete: true, accounting: { matched: 2 } });
  });
  it.each(['repeated-token', 'repeated-id', 'bad-total', 'bad-identity', 'missing-page'] as const)('keeps %s inconclusive instead of claiming absence', async (failure) => {
    const item = { adGroupId: '902', sku: 'SYNTHETIC-SKU', state: 'PAUSED' };
    const row = { ...item, adId: '907' };
    const pages = failure === 'repeated-token' ? [{ productAds: [], nextToken: 'same' }, { productAds: [], nextToken: 'same' }]
      : failure === 'repeated-id' ? [{ productAds: [row], nextToken: 'two' }, { productAds: [row] }]
        : failure === 'bad-total' ? [{ productAds: [], totalResults: 1 }]
          : failure === 'bad-identity' ? [{ productAds: [{ ...item, adId: 907 }] }]
            : [{ productAds: [], nextToken: 'missing' }];
    const { result } = await scan(call('productAds', item), pages);
    expect(result.observation).toBe('pending'); expect(result.complete).toBe(false);
  });
  it('records zero matches only after complete pagination and exposes configuration conflicts', async () => {
    const item = { campaignId: '901', name: 'Synthetic group', state: 'PAUSED', defaultBid: 1 };
    expect((await scan(call('adGroups', item), [{ adGroups: [], totalResults: 0 }])).result).toMatchObject({ observation: 'not_found', complete: true, accounting: { matched: 0 } });
    expect((await scan(call('adGroups', item), [{ adGroups: [{ ...item, adGroupId: '902', state: 'ENABLED' }] }])).result).toMatchObject({ observation: 'conflict', providerEntityId: '902' });
  });
});
