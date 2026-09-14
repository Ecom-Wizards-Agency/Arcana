/** Synthetic legacy-client fixtures and theme-based smoke transport checks. */
import { describe, expect, it, vi } from 'vitest';
import { PROFILE_ID } from './__fixtures__/payloads.js';
import { createMockServer, lwaRoute, testEffects } from './__fixtures__/server.js';
import { AdsApiClient } from './client.js';
import { TokenProvider } from './auth.js';
import { smokeBidRecommendations } from '../scripts/smoke.js';
import type { BidRecommendationTarget } from '@wizard-ads/shared';
import { AdsApiParseError } from './errors.js';
import {
  SP_BID_RECOMMENDATION_ENDPOINTS,
  buildSpBidRecommendationBody, batchSpBidRecommendationIds, parseSpBidRecommendationResponse,
  type SpBidRecommendationKind,
} from './suggested-bids.js';

const CREDENTIALS = {
  clientId: 'amzn1.application-oa2-client.example',
  clientSecret: 'example-client-secret',
  refreshToken: 'fake-refresh-token',
};
const ID_1 = '100000000000001';

function clientFor(routes: Parameters<typeof createMockServer>[0]) {
  const effects = testEffects();
  const server = createMockServer([lwaRoute(), ...routes]);
  return {
    server,
    effects,
    client: new AdsApiClient({
      credentials: CREDENTIALS,
      region: 'NA',
      fetch: server.fetch,
      sleep: effects.sleep,
      now: effects.now,
      random: effects.random,
    }),
  };
}

function target(index: number, isKeyword = true, adGroupId = 'group-one'): BidRecommendationTarget {
  return { targetId: `target-${index}`, campaignId: 'campaign-one', adGroupId, isKeyword,
    targetingExpression: isKeyword ? { type: 'KEYWORD_EXACT_MATCH', value: `synthetic keyword ${index}` }
      : { type: index === 0 ? 'CLOSE_MATCH' : 'LOOSE_MATCH' } };
}
function response(rows: unknown[]) {
  return { bidRecommendations: [{ theme: 'CONVERSION_OPPORTUNITIES', bidRecommendationsForTargetingExpressions: rows }] };
}
function bidRow(target: BidRecommendationTarget, values: unknown[] = [0.45, 0.7, 1.05]) {
  return { targetingExpression: target.targetingExpression, bidValues: values.map((suggestedBid) => ({ suggestedBid })) };
}

// Synthetic contract fixtures: the vendored v3 schema has a theme array, never an indexed 207 envelope.
describe('SP suggested-bid reads', () => {
  for (const kind of ['keywords', 'targets'] as const satisfies readonly SpBidRecommendationKind[]) {
    const endpoint = SP_BID_RECOMMENDATION_ENDPOINTS[kind];
    it(`${kind} maps low/median/high, honors Retry-After, and preserves partial refusal`, async () => {
      const inputs = [target(0, kind === 'keywords'), target(1, kind === 'keywords')];
      const { client, effects, server } = clientFor([{
        method: 'POST', match: endpoint.path, responses: [
          { status: 429, headers: { 'retry-after': '2' }, json: { message: 'slow down' } },
          { status: 200, json: response([bidRow(inputs[1]!, []), bidRow(inputs[0]!)]) },
        ],
      }]);
      const result = kind === 'keywords'
        ? await client.getSpKeywordBidRecommendations(PROFILE_ID, inputs)
        : await client.getSpProductTargetBidRecommendations(PROFILE_ID, inputs);
      expect(result.items).toMatchObject([{ kind, index: 0, targetId: 'target-0', low: 0.45, median: 0.7, high: 1.05, suggestedBid: 0.7 }]);
      expect(result.errors).toMatchObject([{ kind, index: 1, targetId: 'target-1', code: 'NO_BID_VALUES' }]);
      expect(result.items.length + result.errors.length).toBe(result.submitted);
      expect(result).toMatchObject({ offered: 2, eligible: 2, requested: 2, returned: 1, refused: 1, unmatched: 0, batches: 1 });
      expect(effects.slept).toEqual([2_000]);
      expect(server.requestsFor(endpoint.path)).toHaveLength(2);
      const request = server.requestsFor(endpoint.path)[1];
      expect(request?.json).toEqual({ recommendationType: 'BIDS_FOR_EXISTING_AD_GROUP',
        campaignId: 'campaign-one', adGroupId: 'group-one', targetingExpressions: inputs.map((t) => t.targetingExpression) });
      expect(request?.headers['content-type']).toBe('application/vnd.spthemebasedbidrecommendation.v3+json');
      expect(request?.headers['accept']).toBe(endpoint.mediaType);
      expect(request?.headers['amazon-advertising-api-scope']).toBe(PROFILE_ID);
    });
  }

  it('batches 101 keyword expressions, restores global indexes, and loses no target', async () => {
    const inputs = Array.from({ length: 101 }, (_, index) => target(index));
    const endpoint = SP_BID_RECOMMENDATION_ENDPOINTS.keywords;
    const { client, server } = clientFor([{ method: 'POST', match: endpoint.path, responses: [
      { status: 200, json: response(inputs.slice(0, 100).reverse().map((input) => bidRow(input))) },
      { status: 200, json: response([bidRow(inputs[100]!)]) },
    ] }]);
    const result = await client.getSpKeywordBidRecommendations(PROFILE_ID, inputs);
    expect(result.batches).toBe(2);
    expect(result.items).toHaveLength(101);
    expect(result.items[100]?.index).toBe(100);
    expect(new Set(result.items.map((item) => item.index)).size).toBe(101);
    expect(result.items.length + result.errors.length).toBe(result.submitted);
    expect(server.requestsFor(endpoint.path)).toHaveLength(2);
  });

  it('accounts for a partial response that omits a submitted target as a refusal', async () => {
    const inputs = [target(0), target(1)];
    const { client } = clientFor([{ method: 'POST', match: SP_BID_RECOMMENDATION_ENDPOINTS.targets.path,
      responses: [{ status: 200, json: response([bidRow(inputs[0]!)]) }] }]);
    const result = await client.getSpTargetBidRecommendations(PROFILE_ID, inputs);
    expect(result.errors).toMatchObject([{ index: 1, targetId: 'target-1', code: 'MISSING_RECOMMENDATION' }]);
    expect(result).toMatchObject({ offered: 2, eligible: 2, requested: 2, returned: 1, refused: 1, unmatched: 0 });
    expect(result.items.length + result.errors.length).toBe(2);
  });

  it('batches 250 interleaved targets across three ad groups by both campaign and ad-group identity', async () => {
    // Two campaigns deliberately reuse the same ad-group id.
    const groups = [
      Array.from({ length: 125 }, (_, i) => target(i, true, 'group-a')),
      Array.from({ length: 100 }, (_, i) => ({ ...target(i + 125, true, 'group-a'), campaignId: 'campaign-two' })),
      Array.from({ length: 25 }, (_, i) => target(i + 225, true, 'group-b')),
    ];
    const inputs = Array.from({ length: 125 }, (_, i) => groups.flatMap((g) => g[i] ? [g[i]!] : [])).flat();
    const batches = [groups[0]!.slice(0, 100), groups[0]!.slice(100), groups[1]!, groups[2]!];
    const { client, server } = clientFor([{ method: 'POST', match: SP_BID_RECOMMENDATION_ENDPOINTS.targets.path,
      responses: batches.map((batch) => ({ status: 200, json: response(batch.toReversed().map((t) => bidRow(t))) })) }]);
    const result = await client.getSpBidRecommendations(PROFILE_ID, inputs);
    const requests = server.requestsFor(SP_BID_RECOMMENDATION_ENDPOINTS.targets.path);
    expect(requests).toHaveLength(4);
    expect(requests.map((request) => (request.json as { targetingExpressions: unknown[] }).targetingExpressions.length)).toEqual([100, 25, 100, 25]);
    for (const [i, request] of requests.entries()) {
      const batch = batches[i]!;
      expect(request.json).toEqual(buildSpBidRecommendationBody({ campaignId: batch[0]!.campaignId,
        adGroupId: batch[0]!.adGroupId, targetingExpressions: batch.map((t) => t.targetingExpression) }));
      expect(batch.length).toBeLessThanOrEqual(100);
      expect(request.headers['content-type']).toBe('application/vnd.spthemebasedbidrecommendation.v3+json');
      expect(request.headers['accept']).toBe(request.headers['content-type']);
    }
    expect(result).toMatchObject({ offered: 250, eligible: 250, requested: 250, returned: 250, refused: 0, unmatched: 0 });
    expect(result.items).toHaveLength(250);
    expect(new Set(result.items.map((item) => item.index)).size).toBe(250);
    for (const item of result.items) expect(item.targetId).toBe(inputs[item.index]?.targetId);
  });

  it('counts ineligible, matched, unmatched, empty and missing expressions without filling absent bid slots', async () => {
    const inputs = [target(0), target(1), target(2), target(3), { ...target(4), targetingExpression: null }];
    const { client } = clientFor([{ method: 'POST', match: SP_BID_RECOMMENDATION_ENDPOINTS.targets.path,
      responses: [{ status: 200, json: response([
        bidRow(inputs[1]!, ['0.3', null, '0.9']), bidRow(inputs[0]!, [0]),
        bidRow(inputs[2]!, []), bidRow(target(99)),
      ]) }] }]);
    const result = await client.getSpBidRecommendations(PROFILE_ID, inputs);
    expect(result).toMatchObject({ offered: 5, eligible: 4, requested: 4, returned: 2, refused: 2, unmatched: 1 });
    expect(result.items).toMatchObject([
      { targetId: 'target-1', low: 0.3, median: null, high: 0.9 },
      { targetId: 'target-0', low: 0, median: null, high: null },
    ]);
    expect(result.errors.map((e) => e.code)).toEqual(['NO_BID_VALUES', 'MISSING_RECOMMENDATION']);
  });

  it('rejects ambiguous duplicate expressions, malformed responses, and invalid corridors', () => {
    const input = target(0);
    const batch = batchSpBidRecommendationIds([input])[0]!;
    for (const parsed of [null, {}, response([null]), response([bidRow(input), bidRow(input)]),
      response([bidRow(input, [-1])]), response([bidRow(input, [1, 0.5])]), response([bidRow(input, ['bad'])]),
      response([bidRow(input, [0, 1, 2, 3])])]) {
      expect(() => parseSpBidRecommendationResponse(parsed, batch)).toThrow(AdsApiParseError);
    }
    expect(() => batchSpBidRecommendationIds([input, { ...input, targetId: 'different-id' }])).toThrow(/duplicate requested expression/);
    expect(() => batchSpBidRecommendationIds([input, input])).toThrow(/duplicate offered target/);
  });

  it('keeps seasonal suggestions out of daily history and rejects ambiguous or absent base themes', () => {
    const input = target(0);
    const batch = batchSpBidRecommendationIds([input])[0]!;
    const seasonal = { theme: 'PRIME_DAY', bidRecommendationsForTargetingExpressions: [bidRow(input, [1, 2, 3])] };
    const base = response([bidRow(input)]).bidRecommendations[0]!;
    expect(parseSpBidRecommendationResponse({ bidRecommendations: [seasonal, base] }, batch).items[0]?.median).toBe(0.7);
    for (const themes of [[seasonal], [base, base]]) {
      expect(() => parseSpBidRecommendationResponse({ bidRecommendations: themes }, batch)).toThrow(/base theme/);
    }
  });

  it('makes no HTTP call for unsupported v3 targets and rejects the legacy flat-ID input', async () => {
    const { client, server } = clientFor([]);
    expect(await client.getSpBidRecommendations(PROFILE_ID, [{ ...target(0), targetingExpression: null }]))
      .toMatchObject({ offered: 1, eligible: 0, requested: 0, returned: 0, refused: 0, unmatched: 0, batches: 0 });
    // Runtime callers compiled against the old API must fail before HTTP.
    await expect(client.getSpKeywordBidRecommendations(PROFILE_ID, [ID_1] as unknown as BidRecommendationTarget[]))
      .rejects.toThrow(/flat IDs/);
    expect(server.requestsFor(SP_BID_RECOMMENDATION_ENDPOINTS.targets.path)).toHaveLength(0);
  });

  it('validates the shared production/smoke builder against the v3 expression and size limits', () => {
    const scope = { campaignId: 'campaign-one', adGroupId: 'group-one' };
    for (const targetingExpressions of [[], Array.from({ length: 101 }, (_, i) => target(i).targetingExpression),
      [{ type: 'PAT_ASIN', value: 'synthetic product' }], [{ type: 'KEYWORD_EXACT_MATCH' }]]) {
      expect(() => buildSpBidRecommendationBody({ ...scope, targetingExpressions })).toThrow(AdsApiParseError);
    }
  });
});

describe('theme-based bid recommendation smoke (synthetic transport)', () => {
  for (const status of [200, 422]) {
    it(`sends one scoped v3 read and reports raw status ${status} and body shape`, async () => {
      const targetingExpressions = [
        { type: 'KEYWORD_EXACT_MATCH', value: 'synthetic keyword' },
        { type: 'CLOSE_MATCH' },
      ];
      const providerBody = {
        bidRecommendations: [{ theme: 'CONVERSION_OPPORTUNITIES',
          bidRecommendationsForTargetingExpressions: [{
            targetingExpression: targetingExpressions[0],
            bidValues: [{ suggestedBid: 0.4 }, { suggestedBid: 0.6 }, { suggestedBid: 0.8 }],
          }],
        }],
      };
      const responseBody = status === 200 ? providerBody : { code: 'UNPROCESSABLE_ENTITY', details: 'synthetic refusal' };
      const fetch = vi.fn(async () => new Response(JSON.stringify(responseBody), { status }));
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(TokenProvider.prototype, 'getAccessToken').mockResolvedValue(['synthetic', 'token'].join('-'));
      vi.stubGlobal('fetch', fetch);
      const exitCode = process.exitCode;
      try {
        await smokeBidRecommendations({
          lwa: CREDENTIALS, region: 'NA', profileId: PROFILE_ID, date: '',
          bidRecommendations: { campaignId: 'campaign-one', adGroupId: 'group-one', targetingExpressions },
        });
        expect(fetch).toHaveBeenCalledExactlyOnceWith(
          'https://advertising-api.amazon.com/sp/targets/bid/recommendations',
          expect.objectContaining({
            method: 'POST',
            headers: expect.objectContaining({
              'Amazon-Advertising-API-Scope': PROFILE_ID,
              'Content-Type': 'application/vnd.spthemebasedbidrecommendation.v3+json',
              Accept: 'application/vnd.spthemebasedbidrecommendation.v3+json',
            }),
            body: JSON.stringify({
              recommendationType: 'BIDS_FOR_EXISTING_AD_GROUP',
              campaignId: 'campaign-one', adGroupId: 'group-one', targetingExpressions,
            }),
          }),
        );
        expect(log).toHaveBeenCalledTimes(2);
        expect(log).toHaveBeenNthCalledWith(1, `bid-recommendations: requested=2, status=${status}`);
        expect(log).toHaveBeenNthCalledWith(2, expect.stringContaining(status === 200
          ? '"bidValues":{"length":3' : '"details":"string"'));
        expect(JSON.stringify(log.mock.calls)).not.toContain('synthetic refusal');
        expect(JSON.stringify(log.mock.calls)).not.toContain('synthetic keyword');
        expect(process.exitCode).toBe(status === 200 ? exitCode : 1);
      } finally {
        process.exitCode = exitCode;
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
      }
    });
  }
});
