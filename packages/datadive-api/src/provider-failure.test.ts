import { describe, expect, it } from 'vitest';
import { ProviderFailure, isPermanentProviderFailure, type ProviderFailure as Failure } from '@wizard-ads/shared';
import { DataDiveError, DataDiveConfigError, DataDiveParseError, DataDiveHttpError, DataDiveThrottleError, DataDiveTransportError } from './errors.js';

describe('provider failure contract', () => {
  const cases: Array<[Failure & Error, boolean]> = [
    [new DataDiveError('synthetic'), false],
    [new DataDiveConfigError('synthetic'), false],
    [new DataDiveParseError('synthetic'), false],
    [new DataDiveHttpError('synthetic', 503, 1, ''), true],
    [new DataDiveThrottleError(1, 2500, ''), true],
    [new DataDiveTransportError('synthetic', 1), true],
  ];
  it.each(cases)('%s declares retry policy', (error, retryable) => {
    expect(ProviderFailure.parse(error)).toMatchObject({ provider: error.provider, kind: error.kind, retryable });
    expect(isPermanentProviderFailure(error)).toBe(!retryable);
  });
  it('exposes provider pacing in seconds', () => { expect(new DataDiveThrottleError(1, 2500, '').retryAfterSeconds).toBe(2.5); });
});
