import { afterEach, describe, expect, it, vi } from 'vitest';
import { TargetTranslation, TargetTranslationJob } from '@wizard-ads/shared';
import { executeTargetTranslation, type TranslationStore } from './execute.js';
import { notConfiguredTranslationProvider } from './provider.js';
import { ingestionLaneJobTypes, ingestionSource } from '../ingestion-sources.js';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const job = TargetTranslationJob.parse({ type: 'translation.request', orgId: uuid(1), profileId: uuid(2), translationId: uuid(3), requestId: uuid(4) });
const row = TargetTranslation.parse({ id: job.translationId, orgId: job.orgId, profileId: job.profileId, originalText: 'Synthetic original', language: 'en', providerId: 'not-configured', result: { status: 'waiting', text: null, reason: null }, provenance: { requestedAt: '2026-09-14T00:00:00Z', completedAt: null, requestedBy: uuid(5), requestId: job.requestId } });
afterEach(() => vi.unstubAllGlobals());
describe('translation task', () => {
  it('registers on the integrations lane and reconciles completion without network access', async () => {
    const network = vi.fn(() => { throw new Error('Unexpected network access'); });
    vi.stubGlobal('fetch', network);
    const complete = vi.fn(async () => 1);
    const result = await executeTargetTranslation({ read: async () => row, complete }, notConfiguredTranslationProvider, job);
    expect(complete).toHaveBeenCalledWith(job, { status: 'unavailable', text: null, reason: 'provider not configured' }, 'not-configured');
    expect(result).toEqual({ requested: 1, completed: 1, superseded: 0, alreadyCompleted: 0 });
    expect(network).not.toHaveBeenCalled();
    expect(ingestionLaneJobTypes('integrations')).toContain(job.type);
    expect(ingestionSource(job.type).source).toBe('target_translation');
  });
  it('refuses a cross-profile row before invoking the provider', async () => {
    const provider = { id: 'test', translate: vi.fn() };
    await expect(executeTargetTranslation({ read: async () => ({ ...row, profileId: uuid(8) }), complete: vi.fn() }, provider, job)).rejects.toThrow('scope mismatch');
    expect(provider.translate).not.toHaveBeenCalled();
  });
  it('counts stale and duplicate work without repeating completed work', async () => {
    const complete = vi.fn();
    const store: TranslationStore = { read: async () => null, complete };
    expect(await executeTargetTranslation(store, notConfiguredTranslationProvider, job)).toMatchObject({ superseded: 1 });
    store.read = async () => ({ ...row, result: { status: 'unavailable', reason: 'provider not configured', text: null } });
    expect(await executeTargetTranslation(store, notConfiguredTranslationProvider, job)).toMatchObject({ alreadyCompleted: 1 });
    expect(complete).not.toHaveBeenCalled();
  });
});
