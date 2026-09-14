import type { TargetTranslation, TargetTranslationJob, TranslationStatus } from '@wizard-ads/shared';
import type { TranslationProvider } from './provider.js';

export interface TranslationStore {
  read(job: TargetTranslationJob): Promise<TargetTranslation | null>;
  complete(job: TargetTranslationJob, result: TranslationStatus, providerId: string): Promise<number>;
}
export async function executeTargetTranslation(store: TranslationStore, provider: TranslationProvider, job: TargetTranslationJob) {
  const row = await store.read(job);
  if (row === null) return { requested: 1, completed: 0, superseded: 1, alreadyCompleted: 0 };
  if (row.orgId !== job.orgId || row.profileId !== job.profileId || row.id !== job.translationId || row.provenance.requestId !== job.requestId) throw new Error('Translation scope mismatch');
  if (row.result.status !== 'waiting') return { requested: 1, completed: 0, superseded: 0, alreadyCompleted: 1 };
  const result = await provider.translate({ originalText: row.originalText, language: row.language });
  const completed = await store.complete(job, result, provider.id);
  if (completed !== 0 && completed !== 1) throw new Error('Translation completion count mismatch');
  return { requested: 1, completed, superseded: 1 - completed, alreadyCompleted: 0 };
}
