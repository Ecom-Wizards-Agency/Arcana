import { listTargetTranslations } from '@wizard-ads/db';
import { TranslationLanguage, type TargetTranslation } from '@wizard-ads/shared';
import { listProfiles } from '../../../app/_lib/profiles';
import type { ScreenActor } from '../../server/page-read';
import type { ScreenParams } from '../types';

export type TranslationScreenData = { view: 'gated' } | { view: 'empty' } | { view: 'ready'; profileId: string; rows: TargetTranslation[]; canRetry: boolean; language: TranslationLanguage };
export async function load(access: ScreenActor, input: ScreenParams): Promise<TranslationScreenData> {
  if (access.entry.state !== 'ok') return { view: 'gated' };
  const role = access.entry.context.active?.role;
  const language = TranslationLanguage.safeParse(input.searchParams['language'] ?? 'en');
  return access.snapshot(async (snapshot) => {
    const profiles = await listProfiles(snapshot, snapshot.actor.orgId);
    const profile = access.selectProfile(profiles);
    if (!profile) return { view: 'empty' };
    const selectedLanguage = language.success ? language.data : 'en';
    return { view: 'ready', profileId: profile.id, language: selectedLanguage,
      rows: await listTargetTranslations(snapshot, snapshot.actor.orgId, profile.id, selectedLanguage), canRetry: role === 'owner' || role === 'admin' || role === 'analyst' };
  });
}
