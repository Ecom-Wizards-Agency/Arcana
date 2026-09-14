import type { ScreenActor } from '../../server/page-read';

import type { ScreenParams } from '../types';

/** `/campaigns` — guided planning, preflight, and manual bulksheet export. */
import { pageReadErrorMessage } from '../../server/authenticated-page-read';

import { redirect, unstable_rethrow } from 'next/navigation';

import { authenticationDestination } from '../../server/request-context';

import { listOrgProfiles } from '../../recommendations/data';

export async function load(access: ScreenActor, _input: ScreenParams) {

  try {
    return await access.read(async (database, actor) => {
      const profiles = await listOrgProfiles(database, actor.orgId);
      const requested = await Promise.resolve(access.requestedProfile);
      const profile = access.selectProfile(profiles, requested);
      const label = profile?.label ?? 'Selected profile';
      const marketplace = profile?.countryCode ?? 'US';

      return { view: 'ready' as const, props: { profile, label, marketplace } };
    });
  } catch (error) {
    unstable_rethrow(error);
    const authDestination = authenticationDestination(error);
    if (authDestination !== null) redirect(authDestination);
    const message = pageReadErrorMessage(error, 'Campaign Builder is unavailable');
    return { view: 'error' as const, props: { message } };
  }
}
