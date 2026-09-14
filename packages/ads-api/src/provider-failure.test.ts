import { describe, expect, it } from 'vitest';
import { ProviderFailure, isPermanentProviderFailure, type ProviderFailure as Failure } from '@wizard-ads/shared';
import { AdsApiError, AdsApiConfigError, AdsApiHttpError, AdsAuthError, AdsAuthorizationCodeError, AdsThrottleError, DuplicateReportError, UnifiedReportCreateAmbiguousError, DuplicateWriteError, AdsApiNotImplementedError, ReportFailedError, ExportFailedError, AdsApiTimeoutError, AdsApiParseError } from './errors.js';
import { HttpAttemptError, HttpResponseTooLargeError } from './http.js';

describe('provider failure contract', () => {
  const cases: Array<[Failure & Error, boolean]> = [
    [new AdsApiError('synthetic'), false],
    [new AdsApiConfigError('synthetic'), false],
    [new AdsApiHttpError('synthetic', 500, '', 1), true],
    [new AdsAuthError('synthetic', 401, '', 1), false],
    [new AdsAuthorizationCodeError('exchange_uncertain', 503), false],
    [new AdsThrottleError('synthetic', 429, '', 1, 2500), true],
    [new DuplicateReportError('synthetic', 425, '', 1, null), true],
    [new UnifiedReportCreateAmbiguousError(1, 'transport', null), false],
    [new DuplicateWriteError('synthetic', 425, '', 1, 'create', '/synthetic'), true],
    [new AdsApiNotImplementedError('synthetic'), false],
    [new ReportFailedError('synthetic', 'report', 'FAILURE', null), false],
    [new ExportFailedError('synthetic', 'export', 'FAILED', null), false],
    [new AdsApiTimeoutError('synthetic'), true],
    [new AdsApiParseError('synthetic'), false],
    [new HttpAttemptError('fetch', new Error('synthetic')), true],
    [new HttpResponseTooLargeError(1, 2), false],
  ];
  it.each(cases)('%s declares retry policy', (error, retryable) => {
    expect(ProviderFailure.parse(error)).toMatchObject({ provider: error.provider, kind: error.kind, retryable });
    expect(isPermanentProviderFailure(error)).toBe(!retryable);
  });
  it('exposes provider pacing in seconds', () => { expect(new AdsThrottleError('synthetic', 429, '', 1, 2500).retryAfterSeconds).toBe(2.5); });
});
