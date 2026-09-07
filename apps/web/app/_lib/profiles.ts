/** Tenant profile roster. Run within the caller's authenticated transaction;
 * the explicit organization predicate also scopes users with several agencies.
 */
import { cache } from 'react';
import type { AdProfile, QueryHandle } from '@wizard-ads/db';
import { PROFILE_COOKIE } from '../../src/cookies';
import { orderActiveProfiles, resolveActiveProfile } from '../../src/data/active-profile';

export interface ProfileRecord
  extends Pick<
    AdProfile,
    | 'id'
    | 'amazonProfileId'
    | 'region'
    | 'countryCode'
    | 'currencyCode'
    | 'syncEnabled'
    | 'targetAcos'
    | 'monthlyBudget'
    | 'goalLens'
    | 'timezone'
  > {
  label: string;
  /** Doctrine values, per profile. Absent means the widget that needs one is off. */
}

async function readProfiles(handle: QueryHandle, orgId: string): Promise<ProfileRecord[]> {
  const rows = await handle.sql<(Omit<ProfileRecord, 'label'> & { accountName: string | null })[]>`
    select id, amazon_profile_id as "amazonProfileId", account_name as "accountName",
           region, country_code as "countryCode", currency_code as "currencyCode",
           sync_enabled as "syncEnabled", target_acos::float8 as "targetAcos",
           monthly_budget::float8 as "monthlyBudget", goal_lens as "goalLens", timezone
      from public.ad_profiles
     where org_id = ${orgId}
  `;

  return orderActiveProfiles(
    rows.map((row) => ({
      id: row.id,
      amazonProfileId: row.amazonProfileId,
      label: row.accountName ?? row.amazonProfileId,
      region: row.region,
      countryCode: row.countryCode,
      currencyCode: row.currencyCode,
      syncEnabled: row.syncEnabled,
      targetAcos: row.targetAcos,
      monthlyBudget: row.monthlyBudget,
      goalLens: row.goalLens,
      timezone: row.timezone,
    })),
  );
}

/**
 * The top-bar switcher and the active page need the same org-scoped roster.
 * React cache shares the query only inside the current server render; profile
 * edits and later navigations therefore still see fresh database state.
 */
export const listProfiles = cache(readProfiles);

/** The URL wins when it names a profile; the cookie only fills an absent parameter. */
export function profilePreference(
  requested: string | undefined,
  remembered: string | undefined,
): string | undefined {
  return requested ?? remembered;
}

/** Read the browser-independent profile preference for a server-rendered page. */
export async function requestedProfileId(requested: string | undefined): Promise<string | undefined> {
  if (requested !== undefined) return requested;
  // Lazy for the same reason as the frame's request imports: pure tests of this
  // module must not pull `next/headers` into a non-request module graph.
  const { cookies } = await import('next/headers');
  return profilePreference(requested, (await cookies()).get(PROFILE_COOKIE)?.value);
}

/**
 * Which profile a page is about.
 *
 * A URL- or cookie-requested profile that does not exist in the org roster
 * falls back to a default rather than rendering an empty page against an id
 * nobody can see. The exact roster match is what makes the cookie advisory,
 * not an authorization boundary. When nothing is requested the default is the first
 * *sync-enabled* profile: an org of two hundred profiles with three switched on
 * should open on one that actually has data, not on whichever profile happens to
 * sort first — that was the "All profiles" foot-gun from the video. If none is
 * sync-enabled, the first profile stands in so the page still renders.
 */
export function selectProfile(
  profiles: readonly ProfileRecord[],
  requested: string | undefined,
): ProfileRecord | null {
  return resolveActiveProfile(profiles, requested);
}
