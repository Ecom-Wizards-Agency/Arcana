/** A deterministic failure: retain the current attempt and dead-letter immediately. */
export class PermanentJobError extends Error {
  readonly provider = 'worker';
  readonly kind = 'permanent_job';
  readonly retryable = false;
  readonly retryAfterSeconds = undefined;
  constructor(message: string) {
    super(message);
    this.name = 'PermanentJobError';
  }
}
