/**
 * Query normalization for deterministic vocabulary matching and joins.
 *
 * The output is deliberately human-readable rather than a hash. It folds case,
 * Unicode presentation differences, punctuation and repeated whitespace, while
 * leaving word boundaries intact so a short brand token cannot match inside an
 * unrelated word.
 */

import { normalizeResearchQuery } from '@wizard-ads/shared';
export const normalizeQuery = normalizeResearchQuery;

export function queryTokens(value: string): string[] {
  const normalized = normalizeQuery(value);
  return normalized ? normalized.split(' ') : [];
}

/** Exact contiguous token matching; never substring matching. */
export function containsTokenSequence(query: string, candidate: string): boolean {
  const queryParts = queryTokens(query);
  const candidateParts = queryTokens(candidate);
  if (candidateParts.length === 0 || candidateParts.length > queryParts.length) return false;

  for (let start = 0; start <= queryParts.length - candidateParts.length; start += 1) {
    if (candidateParts.every((part, offset) => queryParts[start + offset] === part)) return true;
  }
  return false;
}
