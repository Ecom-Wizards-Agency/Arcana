/**
 * Readable names for Amazon's targeting vocabulary: match types, targeting
 * expressions, target kinds and placements.
 *
 * Amazon spells one concept several ways (`QUERY_HIGH_REL_MATCHES` on the
 * targets endpoint, `close-match` in a report, `close_match` in our mirror), and
 * every one of those spellings reached the screen at some point. This is the one
 * mapping every renderer reads, so a target type reads the same in the grid, the
 * group bar, a filter chip and Target 360. A code this file has never seen is
 * turned into words rather than shown raw; it is never shown as the code.
 *
 * Labels only. Nothing here decides what a target *is* for a bid or a
 * recommendation, and stored values (filters, saved views, exports) keep the
 * code: a label is presentation.
 */
import type { MatchType, Placement } from './primitives.js';

export const MATCH_TYPE_LABELS = {
  exact: 'Exact',
  phrase: 'Phrase',
  broad: 'Broad',
  negative_exact: 'Negative exact',
  negative_phrase: 'Negative phrase',
  asin_same_as: 'Product',
  asin_expanded_from: 'Product and similar',
  asin_brand_same_as: 'Brand',
  asin_category_same_as: 'Category',
  close_match: 'Close match',
  loose_match: 'Loose match',
  substitutes: 'Substitutes',
  complements: 'Complements',
} as const satisfies Record<MatchType, string>;

export const PLACEMENT_LABELS = {
  top_of_search: 'Top of search',
  rest_of_search: 'Rest of search',
  product_pages: 'Product pages',
  off_amazon: 'Off Amazon',
  other: 'Other placements',
} as const satisfies Record<Placement, string>;

/**
 * Target kinds as the facts and Target 360 carry them. `target` covers product
 * targets and the four automatic targeting groups alike, so the automatic ones
 * are told apart by their expression (`targetKindLabel`).
 */
export const TARGET_KINDS = ['keyword', 'target', 'product target'] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];
export const TARGET_KIND_LABELS = {
  keyword: 'Keyword',
  target: 'Product target',
  'product target': 'Product target',
} as const satisfies Record<TargetKind, string>;

/**
 * Targeting-expression predicate types across Sponsored Products, Sponsored
 * Brands and Sponsored Display, in the spelling the targets endpoints return
 * inside `resolvedExpression`.
 */
export const TARGET_EXPRESSION_TYPES = [
  'QUERY_HIGH_REL_MATCHES',
  'QUERY_BROAD_REL_MATCHES',
  'ASIN_SUBSTITUTE_RELATED',
  'ASIN_ACCESSORY_RELATED',
  'ASIN_SAME_AS',
  'ASIN_EXPANDED_FROM',
  'ASIN_CATEGORY_SAME_AS',
  'ASIN_BRAND_SAME_AS',
  'ASIN_PRICE_LESS_THAN',
  'ASIN_PRICE_BETWEEN',
  'ASIN_PRICE_GREATER_THAN',
  'ASIN_REVIEW_RATING_LESS_THAN',
  'ASIN_REVIEW_RATING_BETWEEN',
  'ASIN_REVIEW_RATING_GREATER_THAN',
  'ASIN_IS_PRIME_SHIPPING_ELIGIBLE',
  'ASIN_AGE_RANGE_SAME_AS',
  'ASIN_GENRE_SAME_AS',
  'KEYWORD_GROUP_SAME_AS',
  'KEYWORDS_RELATED_TO_YOUR_BRAND',
  'KEYWORDS_RELATED_TO_YOUR_LANDING_PAGES',
  'SIMILAR_PRODUCT',
  'EXACT_PRODUCT',
  'RELATED_PRODUCT',
  'VIEWS',
  'PURCHASES',
  'AUDIENCE_SAME_AS',
  'LOOKBACK',
] as const;
export type TargetExpressionType = (typeof TARGET_EXPRESSION_TYPES)[number];

/** Which family a target belongs to. Drives the kind label, never a decision. */
export type TargetingGroup = 'keyword' | 'automatic' | 'product' | 'theme' | 'audience';

export const TARGET_EXPRESSION_LABELS = {
  QUERY_HIGH_REL_MATCHES: 'Close match',
  QUERY_BROAD_REL_MATCHES: 'Loose match',
  ASIN_SUBSTITUTE_RELATED: 'Substitutes',
  ASIN_ACCESSORY_RELATED: 'Complements',
  ASIN_SAME_AS: 'Product',
  ASIN_EXPANDED_FROM: 'Product and similar',
  ASIN_CATEGORY_SAME_AS: 'Category',
  ASIN_BRAND_SAME_AS: 'Brand',
  ASIN_PRICE_LESS_THAN: 'Price below',
  ASIN_PRICE_BETWEEN: 'Price between',
  ASIN_PRICE_GREATER_THAN: 'Price above',
  ASIN_REVIEW_RATING_LESS_THAN: 'Rating below',
  ASIN_REVIEW_RATING_BETWEEN: 'Rating between',
  ASIN_REVIEW_RATING_GREATER_THAN: 'Rating above',
  ASIN_IS_PRIME_SHIPPING_ELIGIBLE: 'Prime shipping',
  ASIN_AGE_RANGE_SAME_AS: 'Age range',
  ASIN_GENRE_SAME_AS: 'Genre',
  KEYWORD_GROUP_SAME_AS: 'Keyword group',
  KEYWORDS_RELATED_TO_YOUR_BRAND: 'Keywords related to your brand',
  KEYWORDS_RELATED_TO_YOUR_LANDING_PAGES: 'Keywords related to your landing pages',
  SIMILAR_PRODUCT: 'Similar products',
  EXACT_PRODUCT: 'Advertised products',
  RELATED_PRODUCT: 'Related products',
  VIEWS: 'Views remarketing',
  PURCHASES: 'Purchases remarketing',
  AUDIENCE_SAME_AS: 'Audience',
  LOOKBACK: 'Lookback window',
} as const satisfies Record<TargetExpressionType, string>;

const EXPRESSION_GROUPS: Readonly<Record<TargetExpressionType, TargetingGroup>> = {
  QUERY_HIGH_REL_MATCHES: 'automatic',
  QUERY_BROAD_REL_MATCHES: 'automatic',
  ASIN_SUBSTITUTE_RELATED: 'automatic',
  ASIN_ACCESSORY_RELATED: 'automatic',
  ASIN_SAME_AS: 'product',
  ASIN_EXPANDED_FROM: 'product',
  ASIN_CATEGORY_SAME_AS: 'product',
  ASIN_BRAND_SAME_AS: 'product',
  ASIN_PRICE_LESS_THAN: 'product',
  ASIN_PRICE_BETWEEN: 'product',
  ASIN_PRICE_GREATER_THAN: 'product',
  ASIN_REVIEW_RATING_LESS_THAN: 'product',
  ASIN_REVIEW_RATING_BETWEEN: 'product',
  ASIN_REVIEW_RATING_GREATER_THAN: 'product',
  ASIN_IS_PRIME_SHIPPING_ELIGIBLE: 'product',
  ASIN_AGE_RANGE_SAME_AS: 'product',
  ASIN_GENRE_SAME_AS: 'product',
  KEYWORD_GROUP_SAME_AS: 'theme',
  KEYWORDS_RELATED_TO_YOUR_BRAND: 'theme',
  KEYWORDS_RELATED_TO_YOUR_LANDING_PAGES: 'theme',
  SIMILAR_PRODUCT: 'product',
  EXACT_PRODUCT: 'product',
  RELATED_PRODUCT: 'product',
  VIEWS: 'audience',
  PURCHASES: 'audience',
  AUDIENCE_SAME_AS: 'audience',
  LOOKBACK: 'audience',
};

/** Case, underscores, hyphens and spaces removed: `QUERY_HIGH_REL_MATCHES`, `queryHighRelMatches` and `query-high-rel-matches` meet here. */
function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const EXPRESSION_BY_KEY = new Map<string, TargetExpressionType>(
  TARGET_EXPRESSION_TYPES.map((type) => [normalize(type), type]),
);

/**
 * Report and legacy spellings. `close-match` style names are what the targeting
 * report prints; `asin="…"`, `category="…"` are its product-target clauses.
 */
const EXPRESSION_ALIASES: Readonly<Record<string, TargetExpressionType>> = {
  closematch: 'QUERY_HIGH_REL_MATCHES',
  loosematch: 'QUERY_BROAD_REL_MATCHES',
  substitutes: 'ASIN_SUBSTITUTE_RELATED',
  complements: 'ASIN_ACCESSORY_RELATED',
  asin: 'ASIN_SAME_AS',
  asinexpanded: 'ASIN_EXPANDED_FROM',
  category: 'ASIN_CATEGORY_SAME_AS',
  brand: 'ASIN_BRAND_SAME_AS',
  asinsameasnegative: 'ASIN_SAME_AS',
  asinbrandsameasnegative: 'ASIN_BRAND_SAME_AS',
};

/**
 * A bare lowercase word ("brand", "views", "complements") is somebody's keyword
 * unless the target is known not to be one; codes and hyphenated report names
 * are unmistakable either way.
 */
function expressionType(type: string, allowWords: boolean): TargetExpressionType | null {
  const key = normalize(type);
  const known = EXPRESSION_BY_KEY.get(key) ?? EXPRESSION_ALIASES[key] ?? null;
  if (known === null) return null;
  if (!allowWords && /^[a-z]+$/.test(type)) return null;
  return known;
}

/**
 * A code this file does not know, in words: `ASIN_SHINY_NEW_THING` reads
 * "Asin shiny new thing". Better than the code, and it still names the concept.
 */
export function humanizeCode(value: string): string {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words === '' ? value : words.charAt(0).toUpperCase() + words.slice(1);
}

/** Looks like an identifier rather than words a person typed. */
function isCode(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+$/.test(value) || /^[a-z]+(?:[A-Z][a-z0-9]*)+$/.test(value);
}

/**
 * The last resort for an expression the clause parser could not read whole (a
 * value with an unescaped quote, a clause shape Amazon adds later): every
 * identifier-shaped token is replaced by its label or its words, so no code
 * survives even when the structure does not parse.
 */
function replaceCodes(text: string): string {
  return text
    .replace(/[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+/g, (code) => {
      const type = expressionType(code, true);
      return type === null ? humanizeCode(code) : TARGET_EXPRESSION_LABELS[type];
    })
    .replace(/\s*=\s*"/g, ': ')
    .replace(/"/g, '');
}

const MATCH_TYPE_ALIASES: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Object.entries(MATCH_TYPE_LABELS).map(([key, label]) => [normalize(key), label])),
  campaignnegativeexact: 'Negative exact',
  campaignnegativephrase: 'Negative phrase',
  targetingexpression: 'Product targeting',
  targetingexpressionpredefined: 'Automatic targeting',
};

/** A match type in words. Unknown codes are put into words; null stays null. */
export function matchTypeLabel(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  const known = MATCH_TYPE_ALIASES[normalize(value)];
  if (known !== undefined) return known;
  const expression = expressionType(value, false);
  if (expression !== null) return TARGET_EXPRESSION_LABELS[expression];
  return humanizeCode(value);
}

const PLACEMENT_ALIASES: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Object.entries(PLACEMENT_LABELS).map(([key, label]) => [normalize(key), label])),
  placementtop: PLACEMENT_LABELS.top_of_search,
  topofsearchonamazon: PLACEMENT_LABELS.top_of_search,
  placementrestofsearch: PLACEMENT_LABELS.rest_of_search,
  restofsearchonamazon: PLACEMENT_LABELS.rest_of_search,
  placementproductpage: PLACEMENT_LABELS.product_pages,
  productpage: PLACEMENT_LABELS.product_pages,
  detailpageonamazon: PLACEMENT_LABELS.product_pages,
  otheronamazon: PLACEMENT_LABELS.other,
  amazonbusiness: 'Amazon Business',
  siteamazonbusiness: 'Amazon Business',
  placementsiteamazonbusiness: 'Amazon Business',
};

/** A placement in words, whichever of Amazon's or our spellings arrived. */
export function placementLabel(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  return PLACEMENT_ALIASES[normalize(value)] ?? humanizeCode(value);
}

export interface TargetingClause {
  type: TargetExpressionType;
  label: string;
  value: string | null;
}

export interface TargetingDescription {
  /** What is targeted, in words: the keyword text, or the expression read out. */
  label: string;
  /** The readable type: the match type of a keyword, the expression type otherwise. */
  type: string | null;
  /** The words a shopper searches: keyword text only. Expression targets have none. */
  phrase: string | null;
  group: TargetingGroup;
  /** The parsed expression clauses; empty for a keyword. */
  clauses: readonly TargetingClause[];
}

const CLAUSE = /\s*([A-Za-z][A-Za-z0-9_-]*)(?:\s*=\s*"((?:[^"\\]|\\.)*)")?/y;

/** Every clause, or null when the text is not wholly an expression. */
function parseExpression(text: string, allowWords: boolean): TargetingClause[] | null {
  const clauses: TargetingClause[] = [];
  CLAUSE.lastIndex = 0;
  while (CLAUSE.lastIndex < text.length) {
    const start = CLAUSE.lastIndex;
    const match = CLAUSE.exec(text);
    if (match === null || match.index !== start) return null;
    const rawType = match[1]!;
    const value = match[2] === undefined ? null : match[2].replace(/\\(.)/g, '$1');
    const type = expressionType(rawType, allowWords || value !== null);
    if (type === null) return null;
    clauses.push({ type, label: TARGET_EXPRESSION_LABELS[type], value });
    if (text.slice(CLAUSE.lastIndex).trim() === '') break;
  }
  return clauses.length === 0 ? null : clauses;
}

/**
 * One target, read out. A keyword is its own text; an expression target reads
 * as its clauses (`Close match`, `Product: B000000001`). `targetKind` decides
 * which: a keyword is never parsed, so a keyword that happens to be the word
 * "complements" stays a keyword. Without a kind, only unmistakable expressions
 * (codes, quoted clauses, `close-match`) are read as one.
 */
export function describeTargeting(input: {
  targeting: string | null | undefined;
  targetKind?: string | null | undefined;
  matchType?: string | null | undefined;
}): TargetingDescription {
  const text = (input.targeting ?? '').trim();
  const kind = input.targetKind === null || input.targetKind === undefined ? null : normalize(input.targetKind);
  const matchType = matchTypeLabel(input.matchType);
  if (kind !== 'keyword' && text !== '') {
    const clauses = parseExpression(text, kind !== null);
    if (clauses !== null) {
      const first = clauses[0]!;
      return {
        label: clauses.map((clause) => clause.value === null ? clause.label : `${clause.label}: ${clause.value}`).join(' · '),
        type: first.label,
        phrase: null,
        group: EXPRESSION_GROUPS[first.type],
        clauses,
      };
    }
    // A single identifier-shaped token is a code this file does not know yet.
    if (isCode(text)) return { label: humanizeCode(text), type: humanizeCode(text), phrase: null, group: 'product', clauses: [] };
    // A known non-keyword target whose expression did not parse whole.
    if (kind !== null) return { label: replaceCodes(text), type: matchType, phrase: null, group: 'product', clauses: [] };
  }
  return { label: text, type: matchType, phrase: text === '' ? null : text, group: 'keyword', clauses: [] };
}

/** The kind column in words; an automatic target is not called a product target. */
export function targetKindLabel(kind: string | null | undefined, targeting?: string | null): string | null {
  if (kind === null || kind === undefined || kind.trim() === '') return null;
  const key = kind.trim().toLowerCase().replace(/_/g, ' ');
  if (key === 'keyword') return TARGET_KIND_LABELS.keyword;
  if (key === 'target' || key === 'product target') {
    const group = describeTargeting({ targeting: targeting ?? null, targetKind: 'target' }).group;
    return group === 'automatic' ? 'Automatic target' : group === 'theme' ? 'Theme target' : group === 'audience' ? 'Audience target' : TARGET_KIND_LABELS.target;
  }
  return humanizeCode(kind);
}
