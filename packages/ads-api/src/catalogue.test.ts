import { describe, expect, it } from 'vitest';
import { AdsApiClient } from './client.js';
import { CHANGE_HISTORY_ACCEPT, CHANGE_HISTORY_PATH, PRODUCT_ELIGIBILITY_PATH, PRODUCT_METADATA_MEDIA, PRODUCT_METADATA_PATH, VALIDATION_ENDPOINTS, batchValues, parseChangeHistoryPage, parseProductEligibility } from './catalogue.js';
import { createMockServer, lwaRoute } from './__fixtures__/server.js';

const credentials = { clientId: 'amzn1.application-oa2-client.example', clientSecret: ['synthetic', 'secret'].join('-'), refreshToken: ['synthetic', 'refresh'].join('-') };
function clientFor(routes: Parameters<typeof createMockServer>[0]) { const server = createMockServer([lwaRoute(), ...routes]); return { server, client: new AdsApiClient({ credentials, region: 'NA', fetch: server.fetch, sleep: async () => undefined }) }; }

describe('catalogue contract clients', () => {
  it('uses exact metadata media types and preserves zero and absence', async () => {
    const { client, server } = clientFor([{ method: 'POST', match: PRODUCT_METADATA_PATH, responses: [{ status: 200, json: { ProductMetadataList: [{ asin: 'ASIN000001', priceToPay: { amount: 0, currency: 'USD' }, bestSellerRank: '0' }] } }] }]);
    const page = await client.getProductMetadataPage('profile-one', { asins: ['ASIN000001'], adType: 'SP' });
    expect(page.rows[0]).toMatchObject({ asin: 'ASIN000001', priceToPay: { amount: 0 }, bestSellerRank: 0, availability: null });
    const request = server.requestsFor(PRODUCT_METADATA_PATH)[0]!;
    expect(request.headers['content-type']).toBe(PRODUCT_METADATA_MEDIA.request); expect(request.headers['accept']).toBe(PRODUCT_METADATA_MEDIA.response);
    expect(request.json).toMatchObject({ pageIndex: 0, pageSize: 300, checkItemDetails: true, checkEligibility: false });
  });

  it('accounts for missing eligibility members and SKU fanout', async () => {
    expect(batchValues(Array.from({ length: 301 }, (_, i) => `A${i}`), 300).map((part) => part.length)).toEqual([300, 1]);
    const parsed = parseProductEligibility({ productResponseList: [
      { productDetails: { asin: 'ASIN000001', sku: 'one' }, overallStatus: 'ELIGIBLE', eligibilityStatusList: [] },
      { productDetails: { asin: 'ASIN000001', sku: 'two' }, overallStatus: 'INELIGIBLE', eligibilityStatusList: [{ name: 'OUT_OF_STOCK', severity: 'INELIGIBLE' }] },
    ] }, ['ASIN000001', 'ASIN000002']);
    expect(parsed.rows).toHaveLength(2); expect(parsed.missingAsins).toEqual(['ASIN000002']);
    const { client, server } = clientFor([{ method: 'POST', match: PRODUCT_ELIGIBILITY_PATH, responses: [{ status: 200, json: { productResponseList: [] } }] }]);
    await client.getProductEligibility('profile-one', { asins: ['ASIN000001'], adType: 'SB' });
    expect(server.requestsFor(PRODUCT_ELIGIBILITY_PATH)[0]?.json).toEqual({ adType: 'sb', productDetailsList: [{ asin: 'ASIN000001' }] });
  });

  it('uses schema response keys for both validation resources', async () => {
    const routes = Object.values(VALIDATION_ENDPOINTS).map((endpoint) => ({ method: 'POST', match: endpoint.path, responses: [{ status: 200, json: { [endpoint.responseKey]: { US: { SP: { SELLER: { minDailyBudget: 1 } } } } } }] }));
    const { client, server } = clientFor(routes);
    for (const resource of ['campaigns', 'targeting_clauses'] as const) { const endpoint = VALIDATION_ENDPOINTS[resource]; const result = await client.getValidationConfigurations('profile-one', resource, { countryCodes: ['US'], entityTypes: ['SELLER'], adTypes: ['SP'] }); expect(result.rows).toHaveLength(1); expect(server.requestsFor(endpoint.path)[0]?.headers['content-type']).toBe(endpoint.mediaType); }
  });

  it('uses cursor history pages and excludes unsupported THEME', async () => {
    const event = { entityType: 'CAMPAIGN', entityId: 'campaign-one', changeType: 'STATUS', timestamp: 1789462800000, previousValue: 'PAUSED', newValue: 'ENABLED', metadata: {} };
    const { client, server } = clientFor([{ method: 'POST', match: CHANGE_HISTORY_PATH, responses: [{ status: 200, json: { events: [event], nextToken: 'next' } }] }]);
    expect(await client.getChangeHistoryPage('profile-one', { from: 1789459200000, to: 1789466400000 })).toMatchObject({ sourceRows: 1, nextToken: 'next' });
    const request = server.requestsFor(CHANGE_HISTORY_PATH)[0]!; expect(request.headers['accept']).toBe(CHANGE_HISTORY_ACCEPT); expect(request.json).not.toHaveProperty('eventTypes.THEME');
    expect(() => parseChangeHistoryPage({ events: [{ ...event, entityType: 'THEME' }] })).toThrow(/invalid identity/);
  });
});
