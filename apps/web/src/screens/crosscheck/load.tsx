import type { ScreenActor } from '../../server/page-read';

import type { ScreenParams } from '../types';

/**
 * `/crosscheck` — the verdict history, per profile.
 *
 * A standalone route on purpose. The dashboard (WP-06) owns the page this
 * eventually becomes a panel on; until it exists, the verdicts still have to be
 * readable by a human who is deciding whether to trust the numbers, and that
 * human should not have to run a CLI. The chip and the tables are rendered from
 * `@wizard-ads/crosscheck-cli/pure`'s view model, so moving them onto the
 * dashboard later is an import, not a rewrite.
 *
 * Server component: it reads the database directly and renders. There is no
 * client-side state here, and no Amazon call — every one of those lives in the
 * worker.
 *
 * Entry goes through `gate()`, the same guard `/settings` uses. The profile
 * roster and verdicts run in an authenticated transaction and carry the same
 * explicit organization scope, including for users with several memberships.
 */

import { listCrosscheckedProfiles, loadCrosscheckPanel } from '@wizard-ads/crosscheck-cli';

import type { CrosscheckPanelModel } from '@wizard-ads/crosscheck-cli/pure';

import { listProfiles } from '../../../app/_lib/profiles';

interface PageProps {
  searchParams: Promise<{ profile?: string; }>;
}

export async function load(access: ScreenActor, input: ScreenParams) {
  const searchParams = Promise.resolve(input.searchParams) as PageProps['searchParams'];

  const entry = access.entry;
  if (entry.state !== 'ok') {
    return { view: 'gated' as const, props: { entry } };
  }
  const orgId = entry.context.active?.orgId ?? '';

  const { profile } = await searchParams;

  const data = await access.readNullable(async (handle) => {
    const owned = new Set((await listProfiles(handle, orgId)).map((row) => row.id));
    const profiles = (await listCrosscheckedProfiles(handle, orgId)).filter((row) =>
      owned.has(row.profileId),
    );
    const requested = profile !== undefined && owned.has(profile) ? profile : null;
    const selected = requested ?? profiles[0]?.profileId ?? null;
    const model: CrosscheckPanelModel | null =
      selected === null ? null : await loadCrosscheckPanel(handle, { orgId, profileId: selected });
    // The panel model carries the compared dates; the run time is when the stored verdicts were last written.
    const ranAt = selected === null ? null : (await handle.sql<{ ran_at: string | null }[]>`
      select to_char(max(created_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as ran_at
      from public.crosscheck_results where org_id = ${orgId}::uuid and profile_id = ${selected}::uuid
    `)[0]?.ran_at ?? null;
    return { profiles, selected, model, ranAt };
  });

  if (data === null) {
    return { view: 'no-database' as const, props: {} };
  }

  return { view: 'ready' as const, props: { data } };
}
