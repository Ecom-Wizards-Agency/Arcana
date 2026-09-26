import { describe, expect, it } from 'vitest';
import { decodeSpCreationResponse } from './sp-creation-response.js';
import type { SpWriteKind } from './endpoints.js';

// Explicitly pinned S1 response spellings; not derived from the implementation's endpoint map.
const routes: readonly (readonly [SpWriteKind, string, string, string, string])[] = [
  ['campaigns', 'campaigns', 'campaignId', 'campaign', 'campaignId'],
  ['adGroups', 'adGroups', 'adGroupId', 'adGroup', 'adGroupId'],
  ['productAds', 'productAds', 'adId', 'productAd', 'adId'],
  ['keywords', 'keywords', 'keywordId', 'keyword', 'keywordId'],
  ['targets', 'targetingClauses', 'targetId', 'targetingClause', 'targetId'],
  ['negativeKeywords', 'negativeKeywords', 'negativeKeywordId', 'negativeKeyword', 'keywordId'],
  ['campaignNegativeKeywords', 'campaignNegativeKeywords', 'campaignNegativeKeywordId', 'campaignNegativeKeyword', 'keywordId'],
  ['negativeTargets', 'negativeTargetingClauses', 'targetId', 'negativeTargetingClause', 'targetId'],
  ['campaignNegativeTargets', 'campaignNegativeTargetingClauses', 'campaignNegativeTargetingClauseId', 'campaignNegativeTargetingClauses', 'targetId'],
];
const id = '900719925474099312345';
const encode = (text: string) => new TextEncoder().encode(text);
const parse = (body: unknown, status = 207) => decodeSpCreationResponse('campaigns', status, encode(JSON.stringify(body)));
const missingValue = { errorType: 'missingValueError',
  errorValue: { missingValueError: { reason: 'MISSING_VALUE', message: 'private provider detail' } } };
const success = { index: 0, campaignId: id };
const failure = { index: 0, errors: [missingValue] };

describe('SP creation response correlation', () => {
  it.each(routes)('preserves the exact %s string identity and checks optional representation identity',
    (kind, envelope, idKey, entityKey, nestedId) => {
      const row = { index: 0, [idKey]: id, [entityKey]: { [nestedId]: id } };
      const result = decodeSpCreationResponse(kind, 207, encode(JSON.stringify({ [envelope]: { success: [row] } })));
      expect(result).toEqual({ outcome: 'succeeded', providerEntityId: id, providerCode: null });
      row[entityKey] = { [nestedId]: `${id}1` };
      expect(decodeSpCreationResponse(kind, 207, encode(JSON.stringify({ [envelope]: { success: [row] } }))).outcome)
        .toBe('ambiguous');
      expect(decodeSpCreationResponse(kind, 207, encode(JSON.stringify({ [envelope]: { error: [failure] } }))))
        .toEqual({ outcome: 'authoritative_rejected', providerEntityId: null, providerCode: 'MISSING_VALUE' });
    });

  it.each([
    {}, { success: [] }, { success: null }, { error: null }, { errors: [failure] },
    { success: [success], errors: [failure] }, { success: [success], error: [failure] },
    { success: [success, success] }, { error: [failure, failure] },
    { success: [{ campaignId: id }] }, { success: [{ ...success, index: 1 }] },
    { success: [{ ...success, index: '0' }] }, { success: [{ index: 0 }] },
    { success: [{ ...success, campaignId: null }] }, { success: [{ ...success, campaignId: 123 }] },
    { success: [{ ...success, campaignId: '' }] }, { success: [{ ...success, errors: [] }] },
    { error: [{ ...failure, campaignId: id }] }, { error: [{ index: 0, errors: [] }] },
    { error: [{ index: 0, errors: [{ errorType: 'provider message', errorValue: {} }] }] },
    { error: [{ index: 0, errors: [{ errorType: 'internalServerError', errorValue: {
      internalServerError: { reason: 'INTERNAL_ERROR', message: 'details' } } }] }] },
    { error: [{ index: 0, errors: [{ ...missingValue, errorValue: {
      missingValueError: { reason: 'UNRECOGNIZED', message: 'details' } } }] }] },
    { error: [{ index: 0, errors: [missingValue, { errorType: 'unknown', errorValue: {} }] }] },
  ])('quarantines missing, contradictory or unproven accounting %#', (envelope) => {
    expect(parse({ campaigns: envelope })).toEqual({ outcome: 'ambiguous', providerEntityId: null, providerCode: null });
  });

  it.each(['900719925474099312345', '1e20', '1.0', '-1', '0'])('never coerces numeric ID token %s', (number) => {
    expect(decodeSpCreationResponse('campaigns', 207,
      encode(`{"campaigns":{"success":[{"index":0,"campaignId":${number}}]}}`)).outcome).toBe('ambiguous');
  });

  it.each(['-0', '0.0', '0e0'])('requires canonical index zero: %s', (number) => {
    expect(decodeSpCreationResponse('campaigns', 207,
      encode(`{"campaigns":{"success":[{"index":${number},"campaignId":"${id}"}]}}`)).outcome).toBe('ambiguous');
  });

  it.each([
    '{"campaigns":{"success":[{"index":0,"index":0,"campaignId":"1"}]}}',
    '{"campaigns":{"success":[{"index":0,"campaignId":"1","campaign\\u0049d":"2"}]}}',
    '{"campaigns":{"success":[],"success":[{"index":0,"campaignId":"1"}]}}',
    '{"campaigns":{"success":[{"index":0,"campaignId":"1"},]}}',
    '{"campaigns":{"success":[{"index":0,"campaignId":"1"}]},}',
    '{"campaigns":', '{} trailing', '\ufeff{"campaigns":{"success":[{"index":0,"campaignId":"1"}]}}', '[1]', 'null',
    '{"campaigns":{"success":[{"index":0,"campaignId":"bad\\x00"}]}}',
  ])('rejects invalid JSON or duplicate decoded members %#', (body) => {
    expect(decodeSpCreationResponse('campaigns', 207, encode(body)).outcome).toBe('ambiguous');
  });

  it('rejects invalid UTF-8, excessive depth and oversized input', () => {
    for (const bytes of [new Uint8Array([0xc3, 0x28]), encode('['.repeat(66) + '0' + ']'.repeat(66)),
      encode(' '.repeat(1_048_577))]) {
      expect(decodeSpCreationResponse('campaigns', 207, bytes).outcome).toBe('ambiguous');
    }
  });

  it.each([[400, 'INVALID_ARGUMENT'], [401, 'UNAUTHORIZED'], [403, 'ACCESS_DENIED'],
    [415, 'UNSUPPORTED_MEDIA_TYPE'], [429, 'THROTTLED']] as const)(
    'retains definite whole-request refusal %i without retaining provider prose', (status, code) => {
      expect(parse({ code, message: 'private provider detail' }, status))
        .toEqual({ outcome: 'authoritative_rejected', providerEntityId: null, providerCode: code });
      expect(parse({ code: 'OTHER', message: 'details' }, status).outcome).toBe('ambiguous');
      expect(parse({ code }, status).outcome).toBe('ambiguous');
      expect(parse({ code, message: 'details', campaigns: { success: [success] } }, status).outcome).toBe('ambiguous');
    });

  it.each([200, 201, 204, 301, 409, 500, 503])('never infers a create from undocumented status %i', (status) => {
    expect(parse({ campaigns: { success: [success] } }, status).outcome).toBe('ambiguous');
  });

  it('retains INVALID_ARGUMENT when the documented optional errors array is empty', () => {
    expect(parse({ code: 'INVALID_ARGUMENT', message: 'details', errors: [] }, 400))
      .toEqual({ outcome: 'authoritative_rejected', providerEntityId: null, providerCode: 'INVALID_ARGUMENT' });
  });

  it.each(['internalServerError', 'unknown'])('does not conclude refusal from contradictory type %s', (errorType) => {
    expect(parse({ campaigns: { error: [{ index: 0, errors: [{ ...missingValue, errorType }] }] } }).outcome)
      .toBe('ambiguous');
  });
});
