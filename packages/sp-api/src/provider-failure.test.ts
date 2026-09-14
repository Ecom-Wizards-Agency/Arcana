import { describe, expect, it } from 'vitest';
import { ProviderFailure, isPermanentProviderFailure, type ProviderFailure as Failure } from '@wizard-ads/shared';
import { SpApiError, SpApiParseError, SpApiAuthError, SpApiAmbiguousOutcome } from './errors.js';

describe('provider failure contract', () => {
  const cases: Array<[Failure & Error, boolean]> = [
    [new SpApiError('synthetic', 429, true, 2.5), true],
    [new SpApiParseError('synthetic'), false],
    [new SpApiAuthError('synthetic', 401), false],
    [new SpApiAmbiguousOutcome('transport'), false],
  ];
  it.each(cases)('%s declares retry policy', (error, retryable) => {
    expect(ProviderFailure.parse(error)).toMatchObject({ provider: error.provider, kind: error.kind, retryable });
    expect(isPermanentProviderFailure(error)).toBe(!retryable);
  });
  it('exposes provider pacing in seconds', () => { expect(new SpApiError('synthetic', 429, true, 2.5).retryAfterSeconds).toBe(2.5); });
});
