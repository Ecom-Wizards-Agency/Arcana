import type { TranslationLanguage, TranslationStatus } from '@wizard-ads/shared';

export interface TranslationProvider {
  readonly id: string;
  translate(input: { originalText: string; language: TranslationLanguage }): Promise<Exclude<TranslationStatus, { status: 'waiting' }>>;
}

/** Deliberately has no HTTP client, credentials, or outbound call. */
export const notConfiguredTranslationProvider: TranslationProvider = {
  id: 'not-configured',
  async translate() { return { status: 'unavailable', text: null, reason: 'provider not configured' }; },
};
