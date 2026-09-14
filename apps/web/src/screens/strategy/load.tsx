import { redirect } from 'next/navigation';

import type { ScreenActor } from '../../server/page-read';

import type { ScreenParams } from '../types';

import { listProfiles } from '../../../app/_lib/profiles';

// This compatibility route resolves authentication and the active profile at
// request time. It must never be prerendered with the build process's anonymous
// state, which would permanently bake a redirect to /login into the artifact.
export const dynamic = 'force-dynamic';

/** Backward-compatible deep links now land on the method catalogue. */
export async function load(access: ScreenActor, input: ScreenParams): Promise<never> {
  // Preserve the same anonymous boundary as every other operator screen before
  // forwarding old bookmarks to the method catalogue. Otherwise
  // the hash can survive the dashboard's auth redirect as `/login#...`.
  const entry = access.entry;
  const profile = typeof input.searchParams['profile'] === 'string' ? input.searchParams['profile'] : undefined;
  if (entry.state === 'ok') {
    const requested = access.requestedProfile;
    const orgId = entry.context.active?.orgId ?? '';
    const profiles = await access.readSql(
      (sql) => listProfiles({ sql }, orgId));
    const active = access.selectProfile(profiles, requested);
    if (active !== null) {
      const destination = '/settings/strategy?' + new URLSearchParams({ profile: active.id }).toString();
      redirect(destination);
    }
  }
  redirect(`/settings/strategy${profile === undefined ? '' : `?profile=${encodeURIComponent(profile)}`}`);
}
