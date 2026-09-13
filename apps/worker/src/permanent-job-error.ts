/** A deterministic failure: retain the current attempt and dead-letter immediately. */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentJobError';
  }
}
