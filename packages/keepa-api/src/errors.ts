import type { ProviderFailure } from '@wizard-ads/shared';
export class KeepaError extends Error implements ProviderFailure {
  readonly provider = 'keepa';
  get kind(): string { return this.name; }
  get retryable(): boolean { return false; }
  get retryAfterSeconds(): number | undefined { return undefined; }
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'KeepaError';
  }
}

export class KeepaConfigError extends KeepaError {
  constructor(message: string) {
    super(message);
    this.name = 'KeepaConfigError';
  }
}

export class KeepaParseError extends KeepaError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'KeepaParseError';
  }
}

export class KeepaHttpError extends KeepaError {
  override get retryable(): boolean { return this.status === 429 || this.status === 408 || this.status === 425 || this.status >= 500; }
  constructor(
    message: string,
    readonly status: number,
    readonly attempts: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'KeepaHttpError';
  }
}

/** Token exhaustion is healthy provider pacing, not an integration failure. */
export class KeepaRetryableError extends KeepaError {
  override get retryAfterSeconds(): number | undefined {
    return this.retryAfterMs == null ? undefined : this.retryAfterMs / 1_000;
  }
  override get retryable(): boolean { return true; }
  constructor(
    message: string,
    readonly retryAfterMs: number,
    readonly tokensLeft: number | null,
    readonly requiredTokens: number | null,
  ) {
    super(message);
    this.name = 'KeepaRetryableError';
  }
}
