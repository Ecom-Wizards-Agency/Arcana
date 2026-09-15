/**
 * What the frame needs to know, read without ever being able to break a page.
 *
 * The top bar shows the active organisation and the profiles you can switch
 * between, which means the frame now wants a database read on every route —
 * including `/login`, `/not-found` and the error boundary, none of which have
 * any business failing because a roster could not be listed.
 *
 * So this composes the existing reads (`resolveOrgContext`, `listProfiles`) and
 * swallows everything: no membership, no database, an unreachable one, a
 * malformed cookie. The answer to all of them is the same and it is not an
 * exception — it is a top bar with no switcher, on a page that is perfectly able
 * to explain the real problem itself.
 */
import type { SessionUser } from '../auth/session';
import type { NavProfile } from './topbar-controls';

export interface NavContext {
  orgName: string | null;
  profiles: readonly NavProfile[];
}

const EMPTY: NavContext = { orgName: null, profiles: [] };

type NavProfileSource = Pick<NavProfile, 'id' | 'label' | 'countryCode' | 'syncEnabled' | 'currencyCode' | 'syncLabel' | 'timezone'>;

/** Keep the roster whole while reducing it to exactly what the frame renders. */
export function mapNavProfiles(rows: readonly NavProfileSource[]): NavProfile[] {
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    countryCode: row.countryCode,
    syncEnabled: row.syncEnabled,
    ...(row.timezone === undefined ? {} : { timezone: row.timezone }),
    ...(row.syncLabel === undefined ? {} : { syncLabel: row.syncLabel }),
    ...(row.currencyCode === undefined ? {} : { currencyCode: row.currencyCode }),
  }));
}

export async function navContext(user: SessionUser): Promise<NavContext> {
  try {
    const { database } = await import('../data/db');
    const handle = database();
    if (handle === null) return EMPTY;

    const { resolveOrgContext } = await import('../data/orgs');
    const context = await resolveOrgContext(handle, user);
    const active = context.active;
    if (!active) return EMPTY;

    const { listProfiles } = await import('../../app/_lib/profiles');
    const { withAuthenticatedActor } = await import('@wizard-ads/db');
    const rows = await withAuthenticatedActor(handle, { orgId: active.orgId, userId: user.id },
      async (sql) => {
        const profiles = await listProfiles({ sql }, active.orgId);
        const timestamps = await sql<{ id: string; synced_at: string | null }[]>`
          select id, synced_at::text from public.ad_profiles where org_id = ${active.orgId}
        `;
        const synced = new Map(timestamps.map((row) => [row.id, row.synced_at]));
        return profiles.map((profile) => {
          const value = synced.get(profile.id);
          const hours = value == null ? null : Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 3_600_000));
          return { ...profile, syncLabel: hours === null ? 'Not synced' : `synced ${hours < 1 ? '<1' : hours}h ago` };
        });
      });
    return {
      orgName: active.name,
      profiles: mapNavProfiles(rows),
    };
  } catch {
    return EMPTY;
  }
}
