import { describe, expect, it } from 'vitest';
import { ProviderFailure, isPermanentProviderFailure, type ProviderFailure as Failure } from '@wizard-ads/shared';
import { KeepaError, KeepaConfigError, KeepaParseError, KeepaHttpError, KeepaRetryableError } from './errors.js';

describe('provider failure contract', () => {
  const cases: Array<[Failure & Error, boolean]> = [
    [new KeepaError('synthetic'), false],
    [new KeepaConfigError('synthetic'), false],
    [new KeepaParseError('synthetic'), false],
    [new KeepaHttpError('synthetic', 400, 1), false],
    [new KeepaRetryableError('synthetic', 2500, 0, 1), true],
  ];
  it.each(cases)('%s declares retry policy', (error, retryable) => {
    expect(ProviderFailure.parse(error)).toMatchObject({ provider: error.provider, kind: error.kind, retryable });
    expect(isPermanentProviderFailure(error)).toBe(!retryable);
  });
  it('exposes provider pacing in seconds', () => { expect(new KeepaRetryableError('synthetic', 2500, 0, 1).retryAfterSeconds).toBe(2.5); });
});
