/** Private SP exact-list boundary. Configuration evidence never implies delivery/moderation. */
import { SP_WRITE_ENDPOINTS, type SpWriteKind } from './endpoints.js';
import { JsonNumber, identity, object, parse, type JsonValue, type JsonObject } from './sp-creation-json.js';
import type { SpCreationCompiledCall } from './sp-creation-codec.js';

type ReadState = 'observed' | 'pending' | 'not_found' | 'conflict';
type Comparison = Exclude<ReadState, 'not_found'>;

// List identity aliases are pinned independently from the create response envelope.
const READ_ID: Record<SpWriteKind, string> = {
  campaigns: 'campaignId', adGroups: 'adGroupId', productAds: 'adId', keywords: 'keywordId',
  negativeKeywords: 'keywordId', campaignNegativeKeywords: 'keywordId', targets: 'targetId',
  negativeTargets: 'targetId', campaignNegativeTargets: 'targetId',
};
const EXTRA_FIELDS: Record<SpWriteKind, readonly string[]> = {
  campaigns: ['autoManageCampaign', 'endDate', 'extendedData', 'globalCampaignId',
    'marketplaceBudgetAllocation', 'offAmazonSettings', 'portfolioId', 'siteRestrictions', 'tags'],
  adGroups: ['extendedData', 'globalAdGroupId'],
  productAds: ['asin', 'sku', 'customText', 'extendedData', 'globalAdId', 'globalStoreSetting'],
  keywords: ['bid', 'extendedData', 'globalKeywordId', 'nativeLanguageKeyword', 'nativeLanguageLocale'],
  negativeKeywords: ['extendedData', 'globalKeywordId', 'nativeLanguageKeyword', 'nativeLanguageLocale'],
  campaignNegativeKeywords: ['extendedData', 'globalKeywordId'],
  targets: ['bid', 'extendedData', 'globalTargetId', 'resolvedExpression'],
  negativeTargets: ['extendedData', 'globalTargetId', 'resolvedExpression'],
  campaignNegativeTargets: ['extendedData', 'globalTargetId', 'resolvedExpression'],
};
const PLACEMENTS: readonly string[] = [
  'PLACEMENT_PRODUCT_PAGE', 'PLACEMENT_REST_OF_SEARCH', 'PLACEMENT_TOP', 'SITE_AMAZON_BUSINESS',
];
// Read predicates differ from create predicates and from the negative-target domain.
const POSITIVE_PREDICATES: readonly string[] = [
  'ASIN_ACCESSORY_RELATED', 'ASIN_AGE_RANGE_SAME_AS', 'ASIN_BRAND_SAME_AS',
  'ASIN_CATEGORY_SAME_AS', 'ASIN_EXPANDED_FROM', 'ASIN_GENRE_SAME_AS',
  'ASIN_IS_PRIME_SHIPPING_ELIGIBLE', 'ASIN_PRICE_BETWEEN', 'ASIN_PRICE_GREATER_THAN',
  'ASIN_PRICE_LESS_THAN', 'ASIN_REVIEW_RATING_BETWEEN', 'ASIN_REVIEW_RATING_GREATER_THAN',
  'ASIN_REVIEW_RATING_LESS_THAN', 'ASIN_SAME_AS', 'ASIN_SUBSTITUTE_RELATED',
  'KEYWORD_GROUP_SAME_AS', 'OTHER', 'QUERY_BROAD_REL_MATCHES', 'QUERY_HIGH_REL_MATCHES',
];
const NEGATIVE_PREDICATES: readonly string[] = ['ASIN_BRAND_SAME_AS', 'ASIN_SAME_AS', 'OTHER'];

/** Canonical decimal coefficient/exponent, without binary floating point or large allocations. */
function decimal(source: string): string | null {
  if (source.length > 512) return null;
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(source);
  if (match === null) return null;
  let exponent = Number(match[4] ?? '0') - (match[3]?.length ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1024) return null;
  let coefficient = `${match[2]}${match[3] ?? ''}`.replace(/^0+/, '');
  if (coefficient.length === 0) return '0e0';
  while (coefficient.endsWith('0')) { coefficient = coefficient.slice(0, -1); exponent += 1; }
  return `${match[1]}${coefficient}e${exponent}`;
}

function merge(results: readonly Comparison[]): Comparison {
  return results.includes('pending') ? 'pending' : results.includes('conflict') ? 'conflict' : 'observed';
}

function compare(expected: unknown, actual: JsonValue | undefined): Comparison {
  if (typeof expected === 'number') {
    if (!(actual instanceof JsonNumber)) return 'pending';
    const value = decimal(actual.source);
    return value === null ? 'pending' : value === decimal(String(expected)) ? 'observed' : 'conflict';
  }
  if (typeof expected === 'string' || typeof expected === 'boolean') {
    return typeof actual !== typeof expected ? 'pending' : actual === expected ? 'observed' : 'conflict';
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return 'pending';
    if (expected.length !== actual.length) return 'conflict';
    return merge(expected.map((value, index) => compare(value, actual[index])));
  }
  if (expected !== null && typeof expected === 'object') {
    if (!object(actual)) return 'pending';
    return merge(Object.entries(expected).map(([key, value]) => compare(value, actual[key])));
  }
  return 'pending';
}

function keysWithin(value: JsonObject, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function placementPercentage(value: JsonValue | undefined): boolean {
  if (!(value instanceof JsonNumber)) return false;
  const exact = decimal(value.source);
  const number = Number(value.source);
  return exact !== null && Number.isInteger(number) && number >= 0 && number <= 900
    && decimal(String(number)) === exact;
}

function placements(expected: unknown, actual: JsonValue | undefined): Comparison {
  if (!Array.isArray(expected) || !Array.isArray(actual)) return 'pending';
  const byPlacement = new Map<string, JsonObject>();
  for (const value of actual) {
    if (!object(value) || typeof value.placement !== 'string'
      || !PLACEMENTS.includes(value.placement) || !placementPercentage(value.percentage)
      || !keysWithin(value, ['placement', 'percentage']) || byPlacement.has(value.placement)) return 'pending';
    byPlacement.set(value.placement, value);
  }
  if (actual.length < expected.length) return 'pending';
  if (actual.length > expected.length) return 'conflict';
  return merge(expected.map((value: { placement: string; percentage: number }) => {
    const observed = byPlacement.get(value.placement);
    return observed === undefined ? 'conflict' : compare(value, observed);
  }));
}

function expressionShape(kind: SpWriteKind, value: JsonValue | undefined): boolean {
  const predicates = kind === 'targets' ? POSITIVE_PREDICATES : NEGATIVE_PREDICATES;
  return Array.isArray(value) && value.length > 0 && value.length <= 1000 && value.every((item) => (
    object(item) && typeof item.type === 'string' && predicates.includes(item.type)
      && (item.value === undefined || typeof item.value === 'string')
      && keysWithin(item, ['type', 'value'])
  ));
}

function compareResource(kind: SpWriteKind, expected: Record<string, unknown>, row: JsonObject): Comparison {
  if (!keysWithin(row, [...Object.keys(expected), READ_ID[kind], ...EXTRA_FIELDS[kind]])
    || (row.extendedData !== undefined && !object(row.extendedData))) return 'pending';
  const comparisons: Comparison[] = [];
  for (const [key, value] of Object.entries(expected)) {
    if (key === 'dynamicBidding') continue;
    // S1 explicitly defines omitted keyword/target bid as inheritance.
    if (key === 'bid' && row.bid === undefined) comparisons.push('conflict');
    else if (key === 'endDate' && (row.endDate === undefined || row.endDate === null)) comparisons.push('conflict');
    else comparisons.push(compare(value, row[key]));
  }
  if (kind === 'campaigns') {
    const bidding = expected.dynamicBidding as { strategy: string; placementBidding: unknown };
    if (!object(row.dynamicBidding)
      || !keysWithin(row.dynamicBidding, ['strategy', 'placementBidding', 'shopperCohortBidding'])) {
      comparisons.push('pending');
    } else {
      comparisons.push(compare(bidding.strategy, row.dynamicBidding.strategy));
      comparisons.push(placements(bidding.placementBidding, row.dynamicBidding.placementBidding));
      const shoppers = row.dynamicBidding.shopperCohortBidding;
      // Nonempty cohort controls have no approved recipe/equivalence in this slice.
      if (shoppers !== undefined) comparisons.push(Array.isArray(shoppers) && shoppers.length === 0
        ? 'observed' : 'pending');
    }
    if (!object(row.budget) || !keysWithin(row.budget, ['budget', 'budgetType', 'effectiveBudget'])) {
      comparisons.push('pending');
    } else if (row.budget.effectiveBudget !== undefined) {
      comparisons.push(compare((expected.budget as { budget: number }).budget, row.budget.effectiveBudget));
    }
    if (expected.endDate === undefined && row.endDate !== undefined && row.endDate !== null) {
      comparisons.push(typeof row.endDate === 'string' ? 'conflict' : 'pending');
    }
    if (row.portfolioId !== undefined) comparisons.push(identity(row.portfolioId) ? 'conflict' : 'pending');
    if (row.autoManageCampaign !== undefined) comparisons.push(compare(false, row.autoManageCampaign));
    // No approved recipe defines equivalence for these provider-default controls yet.
    if (row.offAmazonSettings !== undefined || row.marketplaceBudgetAllocation !== undefined) comparisons.push('pending');
    if (row.siteRestrictions !== undefined && row.siteRestrictions !== null) {
      comparisons.push(Array.isArray(row.siteRestrictions) && row.siteRestrictions.length === 1
        && (row.siteRestrictions[0] === 'AMAZON_BUSINESS' || row.siteRestrictions[0] === 'AMAZON_HAUL')
        ? 'conflict' : 'pending');
    }
  }
  if (kind === 'productAds' && (row.customText !== undefined || row.globalStoreSetting !== undefined)) {
    comparisons.push('pending');
  }
  if ((kind === 'keywords' || kind === 'targets') && expected.bid === undefined && row.bid !== undefined) {
    comparisons.push(row.bid instanceof JsonNumber ? 'conflict' : 'pending');
  }
  if (Object.hasOwn(expected, 'expression')) {
    if (!expressionShape(kind, row.expression) || !expressionShape(kind, row.resolvedExpression)) comparisons.push('pending');
  }
  return merge(comparisons);
}

export function spCreationReadbackRequest(call: SpCreationCompiledCall & { providerEntityId: string }) {
  const endpoint = SP_WRITE_ENDPOINTS[call.kind];
  return { path: `${endpoint.path}/list`, mediaType: endpoint.mediaType,
    body: JSON.stringify({ [endpoint.idFilterKey]: { include: [call.providerEntityId] },
      stateFilter: { include: ['ENABLED', 'PAUSED', 'ARCHIVED'] },
      maxResults: 2, includeExtendedDataFields: true }) };
}

export function decodeSpCreationReadback(
  call: SpCreationCompiledCall & { providerEntityId: string }, status: number, body: Uint8Array,
): ReadState {
  try {
    if (status !== 200) return 'pending';
    const endpoint = SP_WRITE_ENDPOINTS[call.kind];
    const root = parse(body);
    if (!object(root) || !keysWithin(root, [endpoint.responseKey, 'nextToken', 'totalResults'])
      || (root.nextToken !== undefined && root.nextToken !== '')) return 'pending';
    const rows = root[endpoint.responseKey];
    if (!Array.isArray(rows) || rows.length > 1
      || (root.totalResults !== undefined && compare(rows.length, root.totalResults) !== 'observed')) return 'pending';
    if (rows.length === 0) return 'not_found';
    const row = rows[0];
    if (!object(row) || !identity(row[READ_ID[call.kind]])
      || row[READ_ID[call.kind]] !== call.providerEntityId) return 'pending';
    // Compiler-owned request only; provider JSON always uses the lossless boundary above.
    const expected = (JSON.parse(call.body) as Record<string, Record<string, unknown>[]>)[endpoint.requestKey]![0]!;
    return compareResource(call.kind, expected, row);
  } catch { return 'pending'; }
}
