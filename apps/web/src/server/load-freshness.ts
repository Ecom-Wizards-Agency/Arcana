import { readProfileFreshness, withAuthenticatedActor } from '@wizard-ads/db';
import type { OrgActor } from '@wizard-ads/shared';
import { assessFreshness } from '@wizard-ads/ui';
import { operatorFailureLabel } from '../security/operator-failure';
import { openWebDatabase } from './request-context';

export async function loadFreshness(actor: OrgActor, profileId: string) {
  const database = openWebDatabase();
  try {
    const evidence = await withAuthenticatedActor(database, actor,
      (sql) => readProfileFreshness({ sql }, actor, profileId));
    return assessFreshness(evidence.entries.map((entry) => 'error' in entry
      ? { ...entry, error: operatorFailureLabel(entry.error) } : entry), { now: new Date() });
  } finally {
    await database.close();
  }
}
