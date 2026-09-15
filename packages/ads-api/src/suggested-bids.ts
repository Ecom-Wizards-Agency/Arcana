/** Theme-based Sponsored Products v3 recommendation reads (no Amazon mutations). */
import {
  BidRecommendationExpression,
  BidRecommendationReadCounts,
  bidRecommendationTargetKey,
  type BidRecommendationCorridor,
  type BidRecommendationTarget,
} from '@wizard-ads/shared';
import { AdsApiParseError } from './errors.js';
import { isRecord, readNumber } from './read.js';

export type SpBidRecommendationKind = 'keywords' | 'targets';
export interface SpBidRecommendationEndpoint { path: string; mediaType: string }

const endpoint: SpBidRecommendationEndpoint = {
  path: '/sp/targets/bid/recommendations',
  mediaType: 'application/vnd.spthemebasedbidrecommendation.v3+json',
};
/** Legacy method names share this route. There is no separate keyword route. */
export const SP_BID_RECOMMENDATION_ENDPOINTS = { keywords: endpoint, targets: endpoint } as const;
export const SP_BID_RECOMMENDATION_BATCH_SIZE = 100;

export interface SpSuggestedBid extends BidRecommendationCorridor {
  kind: SpBidRecommendationKind;
  /** Index in the original offered target array, including ineligible rows. */
  index: number;
  /** v3 has no independent chosen suggestion; this is the middle slot, if present. */
  suggestedBid: number | null;
  raw: Record<string, unknown>;
}
export interface SpBidRecommendationError {
  kind: SpBidRecommendationKind;
  index: number;
  targetId: string;
  code: string;
  details: string | null;
  raw: Record<string, unknown>;
}
export interface SpBidRecommendationResult extends BidRecommendationReadCounts {
  items: SpSuggestedBid[];
  errors: SpBidRecommendationError[];
  /** Compatibility alias for requested. */
  submitted: number;
  batches: number;
}
export interface IndexedBidRecommendationTarget {
  target: BidRecommendationTarget;
  index: number;
}

function expressionKey(expression: { type: string; value?: string }): string {
  return JSON.stringify([expression.type, expression.value ?? null]);
}

/** The same strict builder is used by production and the raw operator probe. */
export function buildSpBidRecommendationBody(input: unknown): {
  recommendationType: 'BIDS_FOR_EXISTING_AD_GROUP';
  campaignId: string;
  adGroupId: string;
  targetingExpressions: BidRecommendationExpression[];
} {
  if (!isRecord(input) || typeof input['campaignId'] !== 'string' || !input['campaignId'].trim()
    || typeof input['adGroupId'] !== 'string' || !input['adGroupId'].trim()) {
    throw new AdsApiParseError('bid recommendations require campaignId and adGroupId');
  }
  const expressions = input['targetingExpressions'];
  if (!Array.isArray(expressions) || expressions.length < 1 || expressions.length > SP_BID_RECOMMENDATION_BATCH_SIZE) {
    throw new AdsApiParseError('bid recommendations require 1..100 targeting expressions');
  }
  const seen = new Set<string>();
  const targetingExpressions = expressions.map((value: unknown) => {
    const parsed = BidRecommendationExpression.safeParse(value);
    if (!parsed.success || (parsed.data.type.startsWith('KEYWORD_') && !parsed.data.value?.trim())) {
      throw new AdsApiParseError('unsupported or incomplete v3 targeting expression');
    }
    const key = expressionKey(parsed.data);
    if (seen.has(key)) throw new AdsApiParseError('ambiguous duplicate requested expression');
    seen.add(key);
    return parsed.data;
  });
  return {
    recommendationType: 'BIDS_FOR_EXISTING_AD_GROUP',
    campaignId: input['campaignId'], adGroupId: input['adGroupId'], targetingExpressions,
  };
}

/** Legacy export name; flat IDs are rejected. Batches retain scope and original indexes. */
export function batchSpBidRecommendationIds(targets: readonly BidRecommendationTarget[]): IndexedBidRecommendationTarget[][] {
  const groups = new Map<string, IndexedBidRecommendationTarget[]>();
  const identities = new Set<string>();
  targets.forEach((target, index) => {
    if (!isRecord(target)) throw new AdsApiParseError('scoped targets are required; flat IDs are unsupported');
    const identity = bidRecommendationTargetKey(target);
    if (identities.has(identity)) throw new AdsApiParseError('duplicate offered target identity');
    identities.add(identity);
    const expression = BidRecommendationExpression.safeParse(target.targetingExpression);
    if (!target.targetId?.trim() || !target.campaignId?.trim() || !target.adGroupId?.trim()
      || !expression.success || target.isKeyword !== expression.data.type.startsWith('KEYWORD_')
      || (target.isKeyword && !expression.data.value?.trim())) return;
    const key = JSON.stringify([target.campaignId, target.adGroupId]);
    const group = groups.get(key) ?? [];
    group.push({ target: { ...target, targetingExpression: expression.data }, index });
    groups.set(key, group);
  });
  const batches: IndexedBidRecommendationTarget[][] = [];
  for (const group of groups.values()) {
    // Check across the entire ad group, including duplicates split across batches.
    const expressions = new Set<string>();
    for (const { target } of group) {
      const key = expressionKey(target.targetingExpression!);
      if (expressions.has(key)) throw new AdsApiParseError('ambiguous duplicate requested expression');
      expressions.add(key);
    }
    for (let index = 0; index < group.length; index += SP_BID_RECOMMENDATION_BATCH_SIZE) {
      batches.push(group.slice(index, index + SP_BID_RECOMMENDATION_BATCH_SIZE));
    }
  }
  return batches;
}

/** Reconcile the base theme by exact expression, never response order or invented IDs. */
export function parseSpBidRecommendationResponse(
  parsed: unknown,
  batch: readonly IndexedBidRecommendationTarget[],
): SpBidRecommendationResult {
  if (!isRecord(parsed) || !Array.isArray(parsed['bidRecommendations'])) {
    throw new AdsApiParseError('bid recommendations response has no theme array');
  }
  const themes = parsed['bidRecommendations'];
  if (themes.some((theme: unknown) => !isRecord(theme) || typeof theme['theme'] !== 'string')) {
    throw new AdsApiParseError('malformed bid recommendation theme');
  }
  const base = themes.filter((theme: Record<string, unknown>) => theme['theme'] === 'CONVERSION_OPPORTUNITIES');
  if (base.length > 1 || (themes.length > 0 && base.length === 0)) {
    throw new AdsApiParseError('bid recommendations require one unambiguous base theme');
  }
  const rows: unknown = base.length === 0 ? [] : base[0]?.['bidRecommendationsForTargetingExpressions'];
  if (!Array.isArray(rows)) throw new AdsApiParseError('bid recommendation theme has no expression array');
  const requested = new Map(batch.map((item) => [expressionKey(item.target.targetingExpression!), item]));
  const seen = new Set<string>();
  const items: SpSuggestedBid[] = [];
  const errors: SpBidRecommendationError[] = [];
  let unmatched = 0;
  for (const row of rows as unknown[]) {
    if (!isRecord(row) || !isRecord(row['targetingExpression'])) {
      throw new AdsApiParseError('malformed returned targeting expression');
    }
    const expression = row['targetingExpression'];
    if (typeof expression['type'] !== 'string'
      || (expression['value'] !== undefined && typeof expression['value'] !== 'string')) {
      throw new AdsApiParseError('malformed returned targeting expression identity');
    }
    const key = expressionKey({ type: expression['type'], ...(expression['value'] === undefined ? {} : { value: expression['value'] }) });
    const match = requested.get(key);
    if (match === undefined) { unmatched += 1; continue; }
    if (seen.has(key)) throw new AdsApiParseError('duplicate returned targeting expression');
    seen.add(key);
    const values = row['bidValues'];
    if (!Array.isArray(values) || values.length > 3) throw new AdsApiParseError('invalid bidValues array');
    const points = [0, 1, 2].map((index) => {
      const slot: unknown = values[index];
      if (slot === undefined || slot === null) return null;
      if (!isRecord(slot)) throw new AdsApiParseError('invalid bid value');
      if (slot['suggestedBid'] === undefined || slot['suggestedBid'] === null) return null;
      const point = readNumber(slot, 'suggestedBid');
      if (point === null || point < 0) throw new AdsApiParseError('invalid suggested bid');
      return point;
    });
    const available = points.filter((point): point is number => point !== null);
    if (available.some((point, index) => index > 0 && point < available[index - 1]!)) {
      throw new AdsApiParseError('unordered bid corridor');
    }
    const kind = match.target.isKeyword ? 'keywords' : 'targets';
    if (available.length === 0) {
      errors.push({ kind, index: match.index, targetId: match.target.targetId, code: 'NO_BID_VALUES', details: null, raw: row });
    } else {
      items.push({ ...match.target, kind, index: match.index,
        low: points[0] ?? null, median: points[1] ?? null, high: points[2] ?? null,
        suggestedBid: points[1] ?? null, raw: row });
    }
  }
  for (const [key, { target, index }] of requested) {
    if (!seen.has(key)) errors.push({ kind: target.isKeyword ? 'keywords' : 'targets', index,
      targetId: target.targetId, code: 'MISSING_RECOMMENDATION', details: null, raw: {} });
  }
  const counts = BidRecommendationReadCounts.parse({ offered: batch.length, eligible: batch.length,
    requested: batch.length, returned: items.length, refused: errors.length, unmatched });
  return { ...counts, items, errors, submitted: batch.length, batches: batch.length > 0 ? 1 : 0 };
}
