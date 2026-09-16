import { CollectorRefusal, type CollectorRefusalCode } from '@wizard-ads/shared';
import { PermanentJobError } from '../permanent-job-error.js';

/** The queue stores error.message, so the validated code must survive that boundary. */
export class CollectorRefusalError extends PermanentJobError {
  readonly code: CollectorRefusalCode;
  constructor(code: CollectorRefusalCode, detail: string) {
    const refusal = CollectorRefusal.parse({ code, detail });
    super(JSON.stringify(refusal));
    this.code = refusal.code;
  }
}
