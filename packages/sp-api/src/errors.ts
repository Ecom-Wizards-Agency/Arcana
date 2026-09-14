import type { ProviderFailure } from '@wizard-ads/shared';

export class SpApiError extends Error implements ProviderFailure {
  readonly provider = 'amazon_spapi';
  readonly kind = 'SpApiError';
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'SpApiError';
  }
}

export class SpApiParseError extends Error implements ProviderFailure {
  readonly provider = 'amazon_spapi';
  readonly kind = 'SpApiParseError';
  readonly retryable = false;
  readonly retryAfterSeconds = undefined;
  constructor(message: string) {
    super(message);
    this.name = 'SpApiParseError';
  }
}

export class SpApiAuthError extends Error implements ProviderFailure {
  readonly provider = 'amazon_spapi';
  readonly kind = 'SpApiAuthError';
  readonly retryAfterSeconds = undefined;
  readonly retryable: boolean;

  constructor(message: string, readonly status: number | null) {
    super(message);
    this.name = 'SpApiAuthError';
    this.retryable = status === 0 || status === 429 || (status !== null && status >= 500);
  }
}

/** A create may have reached Amazon; a queue retry must never POST it again. */
export class SpApiAmbiguousOutcome extends Error implements ProviderFailure {
  readonly provider = 'amazon_spapi';
  readonly kind = 'ambiguous_outcome';
  readonly retryable = false;
  readonly retryAfterSeconds = undefined;
  override readonly name = 'SpApiAmbiguousOutcome';

  constructor(
    readonly phase: 'transport' | 'server-response' | 'response-decoding' | 'provider-id-persistence' | 'checkpoint',
    readonly status: number | null = null,
  ) {
    super(`SP-API report create outcome is unknown after ${phase}`);
  }
}
