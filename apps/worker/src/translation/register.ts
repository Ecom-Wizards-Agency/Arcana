import { completeTranslationAttempt, readTranslationAttempt, type QueryHandle } from '@wizard-ads/db';
import { IngestionRegistry } from '../ingestion-registry.js';
import { executeTargetTranslation } from './execute.js';
import { notConfiguredTranslationProvider } from './provider.js';

/** Runtime capability check bridges the older source-only composition signature. */
export function registerTargetTranslation(registry: Pick<IngestionRegistry, 'register'>, handle: QueryHandle): void {
  if (!(registry instanceof IngestionRegistry)) throw new Error('Translation requires the worker task registry');
  registry.installBuiltin('translation.request', ({ payload }) => executeTargetTranslation({
    read: (job) => readTranslationAttempt(handle, job),
    complete: (job, result, providerId) => completeTranslationAttempt(handle, job, result, providerId),
  }, notConfiguredTranslationProvider, payload));
}
