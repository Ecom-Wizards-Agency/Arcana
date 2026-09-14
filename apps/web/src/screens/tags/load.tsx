import type { ScreenActor } from '../../server/page-read';

import type { ScreenParams } from '../types';

import { pageReadErrorMessage } from '../../server/authenticated-page-read';

import { redirect } from 'next/navigation';

import { authenticationDestination } from '../../server/request-context';

import { listCampaignsByTagFilter, listTagTree } from '@wizard-ads/db';

import { requireOrgRole } from '../../server/org-role';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function load(access: ScreenActor, input: ScreenParams) {
  const searchParams = Promise.resolve(input.searchParams) as { searchParams: SearchParams; }['searchParams'];

  try {
    return await access.read(async (database, actor) => {
      const [tags, campaigns, role] = await Promise.all([
        listTagTree(database, actor.orgId),
        listCampaignsByTagFilter(database, actor.orgId),
        requireOrgRole(database, actor),
      ]);
      const query = await searchParams;
      return { view: 'ready' as const, props: { role, query, tags, campaigns } };
    });
  } catch (error) {
    // A page, not an API: an anonymous visitor gets the login screen.
    const authDestination = authenticationDestination(error);
    if (authDestination !== null) redirect(authDestination);
    const message = pageReadErrorMessage(error, 'Tags are unavailable');
    return { view: 'error' as const, props: { message } };
  }
}
