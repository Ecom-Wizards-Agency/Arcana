import type { ProviderFailure } from '@wizard-ads/shared';
export class DataDiveError extends Error implements ProviderFailure {
  readonly provider = 'datadive';
  get kind(): string { return this.name; }
  get retryable(): boolean { return false; }
  get retryAfterSeconds(): number | undefined { return undefined; }
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DataDiveError';
  }
}

export class DataDiveConfigError extends DataDiveError {
  constructor(message: string) {
    super(message);
    this.name = 'DataDiveConfigError';
  }
}

export class DataDiveParseError extends DataDiveError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DataDiveParseError';
  }
}

export class DataDiveHttpError extends DataDiveError {
  override get retryable(): boolean { return this.status === 429 || this.status === 408 || this.status === 425 || this.status >= 500; }
  constructor(
    message: string,
    readonly status: number,
    readonly attempts: number,
    readonly responseBody: string,
  ) {
    super(message);
    this.name = 'DataDiveHttpError';
  }
}

export class DataDiveThrottleError extends DataDiveHttpError {
  override get retryAfterSeconds(): number | undefined {
    return this.retryAfterMs == null ? undefined : this.retryAfterMs / 1_000;
  }
  constructor(attempts: number, readonly retryAfterMs: number | null, responseBody: string) {
    super(`DataDive rate limit persisted after ${attempts} attempts`, 429, attempts, responseBody);
    this.name = 'DataDiveThrottleError';
  }
}

export class DataDiveTransportError extends DataDiveError {
  override get retryable(): boolean { return true; }
  constructor(message: string, readonly attempts: number, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DataDiveTransportError';
  }
}
