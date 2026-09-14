import { z } from 'zod';

export const TranslationLanguage = z.enum(['en', 'de', 'fr', 'es', 'it', 'pt', 'ja', 'zh']);
export type TranslationLanguage = z.infer<typeof TranslationLanguage>;
export const TRANSLATION_LANGUAGES: Readonly<Record<TranslationLanguage, string>> = {
  en: 'English', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', pt: 'Portuguese', ja: 'Japanese', zh: 'Chinese',
};
export const TranslationRequest = z.strictObject({
  profileId: z.uuid(),
  originalText: z.string().min(1).max(2048).refine((text) => text.trim().length > 0, 'Original wording is required'),
  language: TranslationLanguage.default('en'),
});
export type TranslationRequest = z.infer<typeof TranslationRequest>;
export const TranslationRetry = z.strictObject({ profileId: z.uuid(), translationId: z.uuid() });
export const TranslationProvenance = z.strictObject({
  requestedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  requestedBy: z.uuid(),
  requestId: z.uuid(),
});
export const TranslationStatus = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('waiting'), text: z.null(), reason: z.null() }),
  z.strictObject({ status: z.literal('available'), text: z.string().min(1), reason: z.null() }),
  z.strictObject({ status: z.literal('unavailable'), text: z.null(), reason: z.string().min(1) }),
]);
export type TranslationStatus = z.infer<typeof TranslationStatus>;
export const TargetTranslation = z.strictObject({
  id: z.uuid(), orgId: z.uuid(), profileId: z.uuid(), originalText: TranslationRequest.shape.originalText,
  language: TranslationLanguage, providerId: z.string().min(1),
  result: TranslationStatus, provenance: TranslationProvenance,
});
export type TargetTranslation = z.infer<typeof TargetTranslation>;

export const TranslationView = z.strictObject({ language: TranslationLanguage.default('en') });
