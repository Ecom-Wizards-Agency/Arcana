/** Private SP creation response boundary; see docs/design/WP-215-SP-TRANSPORT.md. */
import { SP_WRITE_ENDPOINTS, type SpWriteKind } from './endpoints.js';

import { JsonNumber, object, parse, identity, type JsonValue, type JsonObject } from './sp-creation-json.js';

export type SpCreationResponse = Readonly<{
  outcome: 'succeeded' | 'authoritative_rejected' | 'ambiguous';
  providerEntityId: string | null;
  providerCode: string | null;
}>;

const ambiguous: SpCreationResponse = { outcome: 'ambiguous', providerEntityId: null, providerCode: null };
const REJECTION_CODES: Readonly<Record<number, string>> = {
  400: 'INVALID_ARGUMENT', 401: 'UNAUTHORIZED', 403: 'ACCESS_DENIED',
  415: 'UNSUPPORTED_MEDIA_TYPE', 429: 'THROTTLED',
};
// S1 selectors present in all nine mutation error schemas. Others remain unclassified.
const REASONS: Readonly<Record<string, readonly string[]>> = {
  missingValueError: ['MISSING_VALUE'],
  malformedValueError: ['BLANK', 'FORBIDDEN_CHARS', 'LEADING_OR_TRAILING_WHITESPACE',
    'PATTERN_NOT_MATCHED', 'TOO_LONG', 'TOO_SHORT'],
  duplicateValueError: ['DUPLICATE_VALUE', 'MARKETPLACE_ATTRIBUTES_REPEATED', 'NAME_NOT_UNIQUE'],
  entityNotFoundError: ['ENTITY_NOT_FOUND'],
  parentEntityError: ['PARENT_ENTITY_ARCHIVED', 'PARENT_ENTITY_DOES_NOT_TARGET_THESE_MARKETPLACES',
    'PARENT_ENTITY_NOT_FOUND'],
  rangeError: ['INVALID_ENUM_VALUE', 'NOT_IN_LIST', 'TOO_HIGH', 'TOO_LOW'],
  throttledError: ['THROTTLED'],
};

function keysWithin(value: JsonObject, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function errorReasons(errors: JsonValue | undefined): string[] | null {
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const reasons: string[] = [];
  for (const error of errors) {
    if (!object(error) || !keysWithin(error, ['errorType', 'errorValue'])
      || typeof error.errorType !== 'string' || error.errorType.length === 0
      || !object(error.errorValue)) return null;
    const selectors = Object.entries(error.errorValue);
    if (selectors.length !== 1) return null;
    const [selector, details] = selectors[0]!;
    // S1 leaves errorType open. This intentionally narrow local rule refuses
    // unknown/contradictory labels; it does not claim all provider spellings.
    if (error.errorType !== selector) return null;
    if (!object(details) || typeof details.message !== 'string' || typeof details.reason !== 'string'
      || !Object.hasOwn(REASONS, selector) || !REASONS[selector]!.includes(details.reason)) return null;
    reasons.push(details.reason);
  }
  return reasons;
}


export function decodeSpCreationResponse(kind: SpWriteKind, status: number, body: Uint8Array,
  expectedParents: Readonly<Partial<Record<'campaignId' | 'adGroupId', string>>> = {}): SpCreationResponse {
  try {
    const root = parse(body);
    if (!object(root)) return ambiguous;
    const rejectionCode = REJECTION_CODES[status];
    if (rejectionCode !== undefined) {
      if (root.code !== rejectionCode || typeof root.message !== 'string'
        || !keysWithin(root, status === 400 ? ['code', 'message', 'errors'] : ['code', 'message'])
        || (root.errors !== undefined && !(Array.isArray(root.errors) && root.errors.length === 0)
          && errorReasons(root.errors) === null)) return ambiguous;
      return { outcome: 'authoritative_rejected', providerEntityId: null, providerCode: rejectionCode };
    }
    if (status !== 207) return ambiguous;
    const endpoint = SP_WRITE_ENDPOINTS[kind];
    const envelope = root[endpoint.responseKey];
    if (!keysWithin(root, [endpoint.responseKey]) || !object(envelope)
      || !keysWithin(envelope, ['success', 'error'])) return ambiguous;
    const success = envelope.success === undefined ? [] : envelope.success;
    const errors = envelope.error === undefined ? [] : envelope.error;
    if (!Array.isArray(success) || !Array.isArray(errors) || success.length + errors.length !== 1) return ambiguous;
    const row = success[0] ?? errors[0];
    if (!object(row) || !(row.index instanceof JsonNumber) || row.index.source !== '0') return ambiguous;
    if (success.length === 1) {
      if (!keysWithin(row, ['index', endpoint.idKey, endpoint.entityKey])) return ambiguous;
      const id = row[endpoint.idKey];
      if (!identity(id)) return ambiguous;
      const representation = row[endpoint.entityKey];
      const representationIdKey = kind === 'negativeKeywords' || kind === 'campaignNegativeKeywords'
        ? 'keywordId' : kind === 'campaignNegativeTargets' ? 'targetId' : endpoint.idKey;
      if (representation !== undefined && (!object(representation)
        || representation[representationIdKey] !== id)) return ambiguous;
      if (object(representation) && Object.entries(expectedParents).some(([key, expected]) => (
        Object.hasOwn(representation, key) && representation[key] !== expected
      ))) return ambiguous;
      return { outcome: 'succeeded', providerEntityId: id, providerCode: null };
    }
    if (!keysWithin(row, ['index', 'errors'])) return ambiguous;
    const reasons = errorReasons(row.errors);
    if (reasons === null) return ambiguous;
    const providerCode = [...new Set(reasons)].sort().join(',');
    if (providerCode.length > 160) return ambiguous;
    return { outcome: 'authoritative_rejected', providerEntityId: null, providerCode };
  } catch {
    return ambiguous;
  }
}
