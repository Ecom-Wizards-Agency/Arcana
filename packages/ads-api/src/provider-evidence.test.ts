import { AdsApiClient } from './client.js';
import { createMockServer, lwaRoute, testEffects } from './__fixtures__/server.js';
import { describe, expect, it } from 'vitest';
import { ProviderCollectionConfig } from '@wizard-ads/shared';
import { buildProviderEvidenceRequest, parseProviderEvidenceResponse, providerReadContract } from './provider-evidence.js';
import { PROVIDER_READ_CONTRACTS } from './provider-contracts.js';
const at = '2026-06-01T00:00:00.000Z';
const id = '00000000-0000-4000-8000-000000000091';
const config = (operation: string, request: Record<string, unknown> = {}) => ProviderCollectionConfig.parse({ id, scope: { orgId: id, profileId: id, marketplaceId: 'synthetic-market', amazonProfileId: 'synthetic-profile' }, family: providerReadContract(operation).family, operation, request, enabled: true, maxPages: 5, maxRows: 1000 });
const recommendation = { adProduct: 'SP', recommendationId: 'synthetic-recommendation', recommendationType: 'CAMPAIGN_BUDGET', status: 'PUBLISHED', campaignId: 'synthetic-campaign', currentValue: '12', recommendedValue: '15' };

describe('pinned provider evidence HTTP dialects', () => {
  it('pins distinct media types and excludes every mutation operation', () => {
    expect(PROVIDER_READ_CONTRACTS).toHaveLength(55);
    expect(new Set(PROVIDER_READ_CONTRACTS.map((c) => c.operation)).size).toBe(55);
    for (const c of PROVIDER_READ_CONTRACTS) {
      expect(c.contractHash).toMatch(/^[a-f0-9]{64}$/);
      expect(c.path).not.toMatch(/\/apply$|\/disassociate$|\/delete$/);
      expect(c.method).not.toBe('PUT');
    }
    expect(() => providerReadContract('tactical.ApplyRecommendations')).toThrow();
    expect(() => providerReadContract('/recommendations/synthetic')).toThrow();
    const request = buildProviderEvidenceRequest(config('tactical.ListRecommendations', { maxResults: 2 }), 'page-two');
    expect(request.contract.contentType).toBe('application/vnd.listRecommendationsRequest.v1+json');
    expect(request.contract.accept).toBe('application/vnd.listRecommendationsResponse.v1+json');
    expect(request.body).toEqual({ maxResults: 2, nextToken: 'page-two' });
  });
  it('preserves Tactical list rows, supplied values, unknown units and pagination', () => {
    const result = parseProviderEvidenceResponse(config('tactical.ListRecommendations'), { recommendations: [recommendation], totalResults: 2, nextToken: 'page-two' }, at);
    expect(result.source).toBe(1); expect(result.rows).toHaveLength(1); expect(result.nextToken).toBe('page-two');
    expect(result.rows[0]?.proposed.value).toBe('15'); expect(result.rows[0]?.proposed.units).toBeNull();
    expect(result.rows[0]?.generatedAt).toBeNull(); expect(result.rows[0]?.expiresAt).toBeNull();
    const again = parseProviderEvidenceResponse(config('tactical.ListRecommendations'), { recommendations: [recommendation], totalResults: 1 }, '2026-06-02T00:00:00.000Z');
    expect(again.rows[0]?.version).toBe(result.rows[0]?.version);
    const resized = parseProviderEvidenceResponse(config('tactical.ListRecommendations', { maxResults: 10 }), { recommendations: [recommendation], totalResults: 1 }, '2026-06-03T00:00:00.000Z');
    expect(resized.rows[0]?.version).toBe(result.rows[0]?.version);
  });
  it('distinguishes empty complete lists from unsupported products and wrong scopes', () => {
    expect(parseProviderEvidenceResponse(config('tactical.ListRecommendations'), { recommendations: [], totalResults: 0 }, at)).toMatchObject({ source: 0, refused: 0, rows: [], status: 'complete' });
    const response = { recommendations: [{ ...recommendation, adProduct: 'ST' }, { ...recommendation, profileId: 'other-profile' }], totalResults: 2 };
    expect(parseProviderEvidenceResponse(config('tactical.ListRecommendations'), response, at)).toMatchObject({ source: 2, refused: 2, rows: [], status: 'partial' });
    expect(parseProviderEvidenceResponse(config('tactical.ListRecommendations', { campaignId: 'other-campaign' }), { recommendations: [recommendation], totalResults: 1 }, at).refused).toBe(1);
  });
  it.each(['sp.getBudgetRecommendations', 'sb.GetBudgetRecommendations', 'sd.getSDBudgetRecommendations'])('reconciles indexed success/error batches for %s', (operation) => {
    const c = config(operation, { campaignIds: ['synthetic-a', 'synthetic-b'] });
    const success = { campaignId: 'synthetic-a', index: 0, suggestedBudget: 10, budgetRuleRecommendation: {}, sevenDaysMissedOpportunities: { startDate: '2026-05-01', endDate: '2026-05-07', estimatedMissedClicksLower: 0 } };
    const error = { campaignId: 'synthetic-b', index: 1, code: 'NOT_ELIGIBLE', details: 'must not retain arbitrary provider error' };
    const indexedError = operation.startsWith('sp.') ? { campaignId: error.campaignId, index: error.index, Error: { code: error.code, details: error.details } } : error;
    const body = operation.startsWith('sb.') ? { success: [success], error: [indexedError] } : { budgetRecommendationsSuccessResults: [success], budgetRecommendationsErrorResults: [indexedError] };
    const parsed = parseProviderEvidenceResponse(c, body, at);
    expect(parsed).toMatchObject({ source: 2, refused: 1, status: 'partial' }); expect(parsed.rows).toHaveLength(1);
    expect(JSON.stringify(parsed)).not.toContain(error.details); expect(parsed.rows[0]?.estimates[0]?.value).toBe(0);
    const missing = operation.startsWith('sb.') ? { success: [], error: [] } : { budgetRecommendationsSuccessResults: [], budgetRecommendationsErrorResults: [] };
    expect(() => parseProviderEvidenceResponse(c, missing, at)).toThrow();
  });
  it('retains research and bid trees at their declared aggregate grain', () => {
    const research = parseProviderEvidenceResponse(config('sp.getCategoryRecommendationsForASINs'), { categories: [] }, at);
    expect(research).toMatchObject({ source: 0, rows: [], status: 'complete' });
    const bid = parseProviderEvidenceResponse(config('sp.GetThemeBasedBidRecommendationForAdGroup_v1', { campaignId: 'synthetic-campaign', adGroupId: 'synthetic-group' }), { bidRecommendations: [] }, at);
    expect(bid.source).toBe(0);
  });

  it('refuses a product-specific result carrying a different ad product', () => {
    const parsed = parseProviderEvidenceResponse(config('sp.getBudgetRecommendations', { campaignIds: ['synthetic-campaign'] }), {
      budgetRecommendationsSuccessResults: [{ campaignId: 'synthetic-campaign', index: 0, adProduct: 'SD', suggestedBudget: 10, budgetRuleRecommendation: {} }],
      budgetRecommendationsErrorResults: [],
    }, at);
    expect(parsed).toMatchObject({ source: 1, refused: 1, rows: [], status: 'partial' });
  });
  it('refuses identity strings that bypass payload redaction', () => {
    const unsafe = ['https:', '//example.invalid/private'].join('');
    const parsed = parseProviderEvidenceResponse(config('tactical.ListRecommendations'), { recommendations: [{ ...recommendation, recommendationId: unsafe }], totalResults: 1 }, at);
    expect(parsed.refused).toBe(1); expect(JSON.stringify(parsed)).not.toContain(unsafe);
  });
});

it('accounts for nested SB forecast successes/errors and missing batch indexes', () => {
  const c = config('sb.SBCampaignPerformanceForecasts', { campaigns: [{ budget: 10, budgetType: 'daily', forecastType: 'CLICKS', adGroups: [{}] }] });
  const success = { campaigns: { successes: [{ index: 0, campaign: { forecasts: [{ metric: 'CLICKS', value: { min: 1, max: 3 } }], forecastTimestamp: at } }], errors: [] } };
  const result = parseProviderEvidenceResponse(c, success, at);
  expect(result).toMatchObject({ source: 1, refused: 0, status: 'complete' }); expect(result.rows[0]?.generatedAt).toBe(at);
  expect(result.rows[0]?.estimates).toEqual([expect.objectContaining({ metric: 'CLICKS', value: null, low: 1, high: 3 })]);
  expect(parseProviderEvidenceResponse(c, { campaigns: { successes: [], errors: [{ index: 0, code: 'UNSUPPORTED', description: 'private' }] } }, at)).toMatchObject({ source: 1, refused: 1, status: 'partial' });
  expect(() => parseProviderEvidenceResponse(c, { campaigns: { successes: [], errors: [] } }, at)).toThrow();
});
it('preserves SD forecast horizons as labeled estimate payloads and incomplete eligibility', () => {
  const c = config('sd.createSDForecast');
  const value = { bidOptimization: 'clicks', weeklyForecasts: [{ metric: 'CLICKS', value: { min: 0, max: 3 } }], forecastStatus: 'COMPLETE' };
  const parsed = parseProviderEvidenceResponse(c, value, at);
  expect(parsed).toMatchObject({ source: 1, refused: 0, status: 'complete' }); expect(parsed.rows[0]?.action).toBe('forecast');
  expect(parsed.rows[0]?.payload['weeklyForecasts']).toEqual(value.weeklyForecasts);
  expect(parseProviderEvidenceResponse(c, { ...value, forecastStatus: 'IMPRESSION_TARGETING_TOO_NARROW' }, at).status).toBe('partial');
});
it('refuses unsupported kinds per row and binds real Tactical campaign filters', () => {
  const c = config('tactical.ListRecommendations', { filters: [{ field: 'CAMPAIGN_ID', operator: 'EXACT', values: ['synthetic-other'] }] });
  expect(parseProviderEvidenceResponse(c, { recommendations: [recommendation], totalResults: 1 }, at).refused).toBe(1);
  expect(parseProviderEvidenceResponse(config('tactical.ListRecommendations'), { recommendations: [{ ...recommendation, recommendationType: 'UNKNOWN_KIND' }], totalResults: 1 }, at).refused).toBe(1);
});

it.each([
  ['tactical.ListRecommendations', { maxResults: 2 }, { recommendations: [recommendation], totalResults: 1 }],
  ['sp.getBudgetRecommendations', { campaignIds: ['synthetic-campaign'] }, { budgetRecommendationsSuccessResults: [{ campaignId: 'synthetic-campaign', index: 0, suggestedBudget: 10, budgetRuleRecommendation: {} }], budgetRecommendationsErrorResults: [] }],
  ['sp.getCategoryRecommendationsForASINs', { asins: ['B000000001'] }, { categories: [] }],
  ['sp.GetThemeBasedBidRecommendationForAdGroup_v1', { campaignId: 'synthetic-campaign', adGroupId: 'synthetic-group', recommendationType: 'BIDS_FOR_EXISTING_AD_GROUP', targetingExpressions: [{ type: 'CLOSE_MATCH' }] }, { bidRecommendations: [] }],
  ['sb.SBCampaignPerformanceForecasts', { campaigns: [{ budget: 10, budgetType: 'daily', forecastType: 'CLICKS', adGroups: [{}] }] }, { campaigns: { successes: [{ index: 0, campaign: { forecasts: [{ metric: 'CLICKS', value: { min: 1, max: 3 } }], forecastTimestamp: at } }], errors: [] } }],
  ['sd.createSDForecast', { campaign: {}, adGroup: {}, productAds: [{}], targetingClauses: [{}] }, { weeklyForecasts: [{ metric: 'CLICKS', value: { min: 1, max: 3 } }], forecastStatus: 'COMPLETE' }],
] as const)('sends only the pinned HTTP read for %s using fake transport', async (operation, request, response) => {
  const c = config(operation, request); const contract = providerReadContract(operation); const effects = testEffects();
  const server = createMockServer([lwaRoute(), { method: contract.method, match: contract.path, responses: [{ status: 200, json: response }] }]);
  const client = new AdsApiClient({ credentials: { clientId: 'synthetic-client', clientSecret: ['synthetic','secret'].join('-'), refreshToken: ['synthetic','refresh'].join('-') }, region: 'NA', fetch: server.fetch, now: effects.now, sleep: effects.sleep, random: effects.random });
  const page = await client.readProviderEvidence(c, null);
  expect(page.source).toBe(page.rows.length + page.refused);
  const calls = server.requests.filter((r) => !r.pathname.includes('auth'));
  expect(calls).toHaveLength(1); expect(calls[0]?.headers['amazon-advertising-api-scope']).toBe(c.scope.amazonProfileId);
  expect(calls[0]?.headers['accept']).toBe(contract.accept); expect(calls[0]?.headers['content-type']).toBe(contract.contentType);
  expect(calls[0]?.method).toBe(contract.method);
});

it('retains typed global country maps and refuses another marketplace', () => {
  const base = config('sp.getGlobalRankedKeywordRecommendation');
  const c = { ...base, scope: { ...base.scope, countryCode: 'US' } };
  const response = { countryCodes: { US: { keywordTargetList: [{ keyword: 'synthetic keyword', recId: 'synthetic-id', bidInfo: [{ bid: 0.5, matchType: 'EXACT' }] }] } } };
  const result = parseProviderEvidenceResponse(c, response, at);
  expect(result.rows[0]?.payload).toEqual(response);
  expect(parseProviderEvidenceResponse(c, { countryCodes: { DE: response.countryCodes.US } }, at).refused).toBe(1);
  expect(() => buildProviderEvidenceRequest(base, null)).toThrow();
});

it.each(['sb.getHeadlineRecommendations','sd.getHeadlineRecommendationsForSD'])('exposes individual creative advice for %s without approval state', (operation) => {
  const headlines = [{ headlineId: 'synthetic-headline', headline: 'A synthetic headline' }];
  const result = parseProviderEvidenceResponse(config(operation), operation.startsWith('sb') ? { requestId: 'synthetic-request', suggestions: headlines } : { requestId: 'synthetic-request', recommendations: headlines }, at);
  expect(result).toMatchObject({ source: 1, refused: 0 }); expect(result.rows[0]).toMatchObject({ providerId: 'synthetic-headline', action: 'headline', proposed: { value: 'A synthetic headline' } });
});

it('reconciles eligibility batches by explicit campaign identity when the contract has no index', () => {
  const c = config('sp.GetOptimizationRuleEligibility', { campaignIds: ['synthetic-a','synthetic-b'] });
  const result = parseProviderEvidenceResponse(c, { CampaignOptimizationRecommendations: [{ campaignId: 'synthetic-a', performanceMetricsExists: true }], CampaignOptimizationRecommendationsError: [{ campaignId: 'synthetic-b', Error: { code: 'NOT_ELIGIBLE', details: 'private provider error' } }] }, at);
  expect(result).toMatchObject({ source: 2, refused: 1, status: 'partial' }); expect(result.rows).toHaveLength(1);
});
it('binds numeric legacy request identities without coercing unsafe integers', () => {
  const c = config('sd.ListAssociatedBudgetRulesForSDCampaigns', { campaignId: 123 });
  const result = parseProviderEvidenceResponse(c, { associatedRules: [{ ruleId: 'synthetic-rule' }] }, at);
  expect(result.refused).toBe(0); expect(result.rows[0]?.entity.campaignId).toBe('123');
});
