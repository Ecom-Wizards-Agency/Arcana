import { withAuthenticatedActor, countChangeQueue } from '@wizard-ads/db';
import { loadCrosscheckPanel } from '@wizard-ads/crosscheck-cli';
import { headers } from 'next/headers';
import { listProfiles } from '../../app/_lib/profiles';
import { resolveActiveProfile } from '../data/active-profile';
import { loadFreshness } from '../server/load-freshness';
import { openWebDatabase, requestActor } from '../server/request-context';
import type { ShellEvidence } from './shell-evidence';

/** One request-owned connection and authenticated transaction for all shell evidence. */
export async function readShellEvidence(requested: string | null): Promise<ShellEvidence | null> {
  try {
    const actor = await requestActor(await headers());
    const database = openWebDatabase();
    try {
      return await withAuthenticatedActor(database, actor, async (sql) => {
        const profiles = await listProfiles({ sql }, actor.orgId);
        // An explicit foreign or removed profile must never fall back to another account.
        const profile = requested === null ? resolveActiveProfile(profiles, undefined)
          : profiles.find((candidate) => candidate.id === requested) ?? null;
        if (profile === null) return null;
        const freshness = await loadFreshness(actor, profile.id, { sql });
        const panel = await loadCrosscheckPanel({ sql }, { orgId: actor.orgId, profileId: profile.id });
        const [row] = await sql<{ count: number }[]>`
          select count(*)::integer as count from public.experiments
          where org_id = ${actor.orgId} and profile_id = ${profile.id} and status = 'running'
        `;
        return { profileId: profile.id, freshness, crosscheck: panel.chip,
          // Review receipts do not imply an Amazon application.
          badges: { 'change-queue': await countChangeQueue({ sql }, { orgId: actor.orgId, profileId: profile.id }), timeline: row?.count ?? null } };
      });
    } finally { await database.close(); }
  } catch {
    // Optional chrome cannot reject a page render or a navigation to not-found.
    return null;
  }
}
