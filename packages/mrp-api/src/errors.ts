import type { ProviderFailure } from '@wizard-ads/shared';
export class MrpApiError extends Error implements ProviderFailure {
  readonly provider = 'mrp';
  get kind(): string { return this.name; }
  get retryable(): boolean { return false; }
  get retryAfterSeconds(): number | undefined { return undefined; }
  override readonly name: string = 'MrpApiError';
}

export class MrpConfigError extends MrpApiError {
  override readonly name = 'MrpConfigError';
}

export class MrpHttpError extends MrpApiError {
  override get retryable(): boolean { return this.status === 429 || this.status === 408 || this.status === 425 || this.status >= 500; }
  override readonly name: string = 'MrpHttpError';

  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class MrpTransportError extends MrpApiError {
  override get retryable(): boolean { return true; }
  override readonly name = 'MrpTransportError';
}

export class MrpAuthError extends MrpHttpError {
  override readonly name = 'MrpAuthError';
}

export class MrpProtocolError extends MrpApiError {
  override readonly name = 'MrpProtocolError';
}

export class MrpToolNotFoundError extends MrpApiError {
  override readonly name = 'MrpToolNotFoundError';
}

export class MrpToolCallError extends MrpApiError {
  override readonly name = 'MrpToolCallError';
}

export class MrpParseError extends MrpApiError {
  override readonly name = 'MrpParseError';
}
