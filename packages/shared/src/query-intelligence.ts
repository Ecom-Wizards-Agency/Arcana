/** Search Query Performance, vocabulary, and review-only negative contracts. */
import { z } from 'zod';
import { AmazonId, IsoDate, Uuid } from './primitives.js';

const count = z.number().int().nonnegative();
const ratio = z.number().min(0).max(1);

export const QueryCategory = z.enum([
  'own_brand',
  'competitor',
  'core',
  'head',
  'excluded',
  'unreviewed',
]);
export type QueryCategory = z.infer<typeof QueryCategory>;

export const QueryVocabularyKind = z.enum([
  'own_brand_term',
  'own_brand_alias',
  'competitor_brand',
  'competitor_asin',
  'core_term',
  'exclusion',
]);
export type QueryVocabularyKind = z.infer<typeof QueryVocabularyKind>;

export const QueryVocabularySource = z.enum(['operator', 'import', 'ai_suggestion']);
export type QueryVocabularySource = z.infer<typeof QueryVocabularySource>;

export const QueryVocabularyEntry = z.object({
  id: Uuid.optional(),
  orgId: Uuid,
  marketplaceId: AmazonId,
  kind: QueryVocabularyKind,
  value: z.string().trim().min(1),
  normalizedValue: z.string().trim().min(1),
  source: QueryVocabularySource,
  approved: z.boolean(),
  reviewedAt: z.iso.datetime().nullable(),
});
export type QueryVocabularyEntry = z.infer<typeof QueryVocabularyEntry>;

export const SqpWeeklyFact = z.object({
  profileId: Uuid,
  marketplaceId: AmazonId,
  asin: AmazonId,
  weekStart: IsoDate,
  weekEnd: IsoDate,
  searchQuery: z.string().min(1),
  normalizedQuery: z.string().min(1),
  category: QueryCategory,
  searchQueryScore: z.number().nonnegative().nullable(),
  searchQueryVolume: count,
  totalImpressions: count,
  asinImpressions: count,
  asinImpressionShare: ratio,
  totalClicks: count,
  asinClicks: count,
  asinClickShare: ratio,
  totalCartAdds: count,
  asinCartAdds: count,
  asinCartAddShare: ratio,
  totalPurchases: count,
  asinPurchases: count,
  asinPurchaseShare: ratio,
});
export type SqpWeeklyFact = z.infer<typeof SqpWeeklyFact>;

export const QueryJoinAttribution = z.enum([
  'asin_exact',
  'profile_only',
  'ambiguous',
  'unmatched',
]);
export type QueryJoinAttribution = z.infer<typeof QueryJoinAttribution>;

export const ContextualNegativeProposal = z.object({
  id: Uuid.optional(),
  profileId: Uuid,
  marketplaceId: AmazonId,
  campaignId: AmazonId,
  adGroupId: AmazonId,
  searchTerm: z.string().min(1),
  normalizedQuery: z.string().min(1),
  category: QueryCategory,
  sourceGroupRole: z.enum(['rank', 'discovery', 'profit', 'shield']),
  matchType: z.enum(['negative_exact', 'negative_phrase']),
  reason: z.string().min(1),
  status: z.enum(['proposed', 'accepted', 'dismissed', 'exported']),
});
export type ContextualNegativeProposal = z.infer<typeof ContextualNegativeProposal>;

export const SqpIngestionCounts = z.object({
  sourceAsins: count,
  sourceRows: count,
  parsedRows: count,
  deduplicatedRows: count,
  refusedRows: count,
  upserts: count,
});
export type SqpIngestionCounts = z.infer<typeof SqpIngestionCounts>;

export const QueryVocabularyMutation = z.discriminatedUnion('action', [
  z.object({ action: z.literal('add'), profileId: Uuid, kind: QueryVocabularyKind, value: z.string().trim().min(1).max(300) }).strict(),
  z.object({ action: z.literal('approve'), profileId: Uuid, id: Uuid }).strict(),
  z.object({ action: z.literal('remove'), profileId: Uuid, id: Uuid }).strict(),
]);
export type QueryVocabularyMutation = z.infer<typeof QueryVocabularyMutation>;

/** Public Amazon marketplace identifiers keyed by Ads profile country code. */
const QUERY_MARKETPLACE_IDS: Readonly<Record<string, string>> = {
  CA: 'A2EUQ1WTGCTBG2',
  US: 'ATVPDKIKX0DER',
  MX: 'A1AM78C64UM0Y8',
  BR: 'A2Q3Y263D00KWC',
  IE: 'A28R8C7NBKEWEA',
  ES: 'A1RKKUPIHCS9HS',
  UK: 'A1F83G8C2ARO7P',
  GB: 'A1F83G8C2ARO7P',
  FR: 'A13V1IB3VIYZZH',
  BE: 'AMEN7PMS3EDWL',
  NL: 'A1805IZSGTT6HS',
  DE: 'A1PA6795UKMFR9',
  IT: 'APJ6JRA9NG5V4',
  SE: 'A2NODRKZP88ZB9',
  ZA: 'AE08WJ6YKNBMC',
  PL: 'A1C3SOZRARQ6R3',
  EG: 'ARBP9OOSHTCHU',
  TR: 'A33AVAJ2PDY3EV',
  SA: 'A17E79C6D8DWNP',
  AE: 'A2VIGQ35RCS4UG',
  IN: 'A21TJRUUN4KGV',
  SG: 'A19VAU5U5O7RUS',
  AU: 'A39IBJ37TRP1C6',
  JP: 'A1VC38T7YXB528',
};

/** Amazon marketplace string id for a profile country code. */
export function queryMarketplaceIdForCountry(countryCode: string): string | null {
  return QUERY_MARKETPLACE_IDS[countryCode.trim().toUpperCase()] ?? null;
}

const COMBINING_MARK = /\p{M}+/gu;
const NON_ALPHANUMERIC = /[^\p{L}\p{N}]+/gu;

function joinSpelledTokens(tokens: string[]): string[] {
  const output: string[] = [];
  for (let index = 0; index < tokens.length; ) {
    if ([...(tokens[index] ?? '')].length !== 1) {
      output.push(tokens[index] as string);
      index += 1;
      continue;
    }

    let end = index;
    while (end < tokens.length && [...(tokens[end] ?? '')].length === 1) end += 1;
    if (end - index >= 3) output.push(tokens.slice(index, end).join(''));
    else output.push(tokens[index] as string);
    index = end;
  }
  return output;
}

/** Normalize a customer query or vocabulary entry without stemming it. */
export function normalizeResearchQuery(value: string): string {
  const tokens = value
    .normalize('NFKD')
    .replace(COMBINING_MARK, '')
    .toLocaleLowerCase('und')
    .replace(NON_ALPHANUMERIC, ' ')
    .trim()
    .split(/\s+/u)
    .filter(Boolean);

  return joinSpelledTokens(tokens).join(' ');
}
