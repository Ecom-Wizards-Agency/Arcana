import { readProfileFreshness, withAuthenticatedActor, type QueryHandle } from '@wizard-ads/db';
import type { OrgActor } from '@wizard-ads/shared';
import { assessFreshness } from '@wizard-ads/ui';
import { operatorFailureLabel } from '../security/operator-failure';
import { openWebDatabase } from './request-context';

/** A supplied handle must belong to the caller's authenticated transaction. */
export async function loadFreshness(actor: OrgActor, profileId: string, handle?: QueryHandle) {
  if (handle !== undefined) return assessProfileFreshness(handle, actor, profileId);
  const database = openWebDatabase();
  try {
    return await withAuthenticatedActor(database, actor,
      (sql) => assessProfileFreshness({ sql }, actor, profileId));
  } finally {
    await database.close();
  }
}

async function assessProfileFreshness(handle: QueryHandle, actor: OrgActor, profileId: string) {
  const evidence = await readProfileFreshness(handle, actor, profileId);
  return assessFreshness(evidence.entries.map((entry) => 'error' in entry
    ? { ...entry, error: operatorFailureLabel(entry.error) } : entry), { now: new Date() });
}
