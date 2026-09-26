/**
 * What the translation column may translate: keyword phrases, nothing else.
 *
 * Product targets, automatic and theme targets, audience expressions, ASINs,
 * campaign names and internal ids are codes or names, not words a shopper
 * typed; translating them would invent meaning. A grid row is judged by its
 * target kind and match type first, then by the shared `describeTargeting`.
 * A row the facts call a keyword stays a keyword whatever its text looks like
 * ("iPhone", "USB_C", "1080"); only an ASIN, a UUID or the target-id fallback is
 * refused there. The translation API sees text alone, so it refuses only text
 * that cannot be a keyword: quoted clauses, expression codes and report names.
 */
import { describeTargeting, MATCH_TYPE_LABELS, matchTypeLabel, TARGET_EXPRESSION_TYPES } from '@wizard-ads/shared';

const KEYWORD_MATCH_LABELS: ReadonlySet<string> = new Set([
  MATCH_TYPE_LABELS.exact, MATCH_TYPE_LABELS.phrase, MATCH_TYPE_LABELS.broad,
  MATCH_TYPE_LABELS.negative_exact, MATCH_TYPE_LABELS.negative_phrase,
]);
const EXPRESSION_CODES: ReadonlySet<string> = new Set(TARGET_EXPRESSION_TYPES);
const ASIN = /^b0[a-z0-9]{8}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QUOTED_CLAUSE = /[A-Za-z][A-Za-z0-9_-]*\s*=\s*"/;
const HYPHENATED = /^[a-z]+(?:-[a-z]+)+$/;

/**
 * Text that can only be a targeting expression: a quoted clause (`asin="…"`),
 * an expression code (`QUERY_HIGH_REL_MATCHES`), or a hyphenated report name
 * that reads as one (`close-match`, `loose-match`). "co-sleeper" is not one.
 */
export function isUnambiguousExpression(text: string): boolean {
  const trimmed = text.trim();
  if (QUOTED_CLAUSE.test(trimmed)) return true;
  if (EXPRESSION_CODES.has(trimmed)) return true;
  if (HYPHENATED.test(trimmed)) return describeTargeting({ targeting: trimmed }).clauses.length > 0;
  return false;
}

/** An identifier that is never a phrase, whatever the row says it is. */
function isIdentifier(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === '' || ASIN.test(trimmed) || UUID.test(trimmed);
}

/**
 * The exact original a grid row may send for translation, or null when the row
 * is not a keyword phrase.
 */
export function translatablePhrase(dimensions: Readonly<Record<string, unknown>>): string | null {
  const targeting = dimensions['targeting'];
  if (typeof targeting !== 'string') return null;
  // The grid shows the target id when a target has no text; an id is never a phrase.
  if (targeting === dimensions['target_id'] || isIdentifier(targeting)) return null;
  const kind = typeof dimensions['target_kind'] === 'string' ? dimensions['target_kind'].trim().toLowerCase().replace(/[_\s]+/g, ' ') : null;
  if (kind === 'keyword') return targeting;
  if (kind !== null && kind !== '') return null;
  const matchType = typeof dimensions['match_type'] === 'string' ? dimensions['match_type'] : null;
  const matchLabel = matchTypeLabel(matchType);
  if (matchLabel !== null) return KEYWORD_MATCH_LABELS.has(matchLabel) && !isUnambiguousExpression(targeting) ? targeting : null;
  // Neither kind nor match type: the text alone decides, through the shared reader.
  const described = describeTargeting({ targeting });
  return described.group === 'keyword' && described.phrase !== null && !isUnambiguousExpression(targeting) ? targeting : null;
}
