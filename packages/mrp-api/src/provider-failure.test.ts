import { describe, expect, it } from 'vitest';
import { ProviderFailure, isPermanentProviderFailure, type ProviderFailure as Failure } from '@wizard-ads/shared';
import { MrpApiError, MrpConfigError, MrpHttpError, MrpTransportError, MrpAuthError, MrpProtocolError, MrpToolNotFoundError, MrpToolCallError, MrpParseError } from './errors.js';

describe('provider failure contract', () => {
  const cases: Array<[Failure & Error, boolean]> = [
    [new MrpApiError('synthetic'), false],
    [new MrpConfigError('synthetic'), false],
    [new MrpHttpError('synthetic', 429), true],
    [new MrpTransportError('synthetic'), true],
    [new MrpAuthError('synthetic', 401), false],
    [new MrpProtocolError('synthetic'), false],
    [new MrpToolNotFoundError('synthetic'), false],
    [new MrpToolCallError('synthetic'), false],
    [new MrpParseError('synthetic'), false],
  ];
  it.each(cases)('%s declares retry policy', (error, retryable) => {
    expect(ProviderFailure.parse(error)).toMatchObject({ provider: error.provider, kind: error.kind, retryable });
    expect(isPermanentProviderFailure(error)).toBe(!retryable);
  });
});
