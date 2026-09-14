import type { ScreenActor } from '../../server/page-read';

import type { ScreenParams } from '../types';

/**
 * `/experiments` — the tracker of deliberate tests.
 *
 * Server-rendered from the database on first load, then the client re-reads
 * `/api/experiments` when the profile or status filter changes, so the list is
 * always an answer to the same org-scoped query rather than a browser-side
 * narrowing. Reads use the verified session (or isolated test bridge), current
 * agency membership and an authenticated database transaction.
 */
import { pageReadErrorMessage } from '../../server/authenticated-page-read';

import { redirect } from 'next/navigation';

import { listExperiments } from '@wizard-ads/db';

import { authenticationDestination } from '../../server/request-context';

import { requireOrgRole } from '../../server/org-role';

import { listProfileOptions, listProposedTests, selectProfileId } from '../../experiments/data';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const single = (value: string | string[] | undefined): string | null =>
  typeof value === 'string' ? value : null;

export async function load(access: ScreenActor, input: ScreenParams) {
  const searchParams = Promise.resolve(input.searchParams) as { searchParams: SearchParams; }['searchParams'];

  try {
    return await access.read(async (database, actor) => {
      const role = await requireOrgRole(database, actor);
      const query = await searchParams;
      const profiles = await listProfileOptions(database, actor.orgId);
      const selectedProfileId = selectProfileId(profiles, single(query['profile']));
      const [items, proposedTests] = selectedProfileId
        ? await Promise.all([
          listExperiments(database, { orgId: actor.orgId, profileId: selectedProfileId }),
          listProposedTests(database, { orgId: actor.orgId, profileId: selectedProfileId }),
        ])
        : [[], []];

      return { view: 'ready' as const, props: { items, profiles, selectedProfileId, proposedTests, role } };
    });
  } catch (error) {
    const authDestination = authenticationDestination(error);
    if (authDestination !== null) redirect(authDestination);
    const message = pageReadErrorMessage(error, 'Experiments are unavailable');
    return { view: 'error' as const, props: { message } };
  }
}
