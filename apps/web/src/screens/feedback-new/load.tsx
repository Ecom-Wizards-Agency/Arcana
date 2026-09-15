import type { ScreenActor } from '../../server/page-read';

import type { ScreenParams } from '../types';

/**
 * Submit a bug or a feature request.
 *
 * The page the reporter came from arrives as `?from=`, put there by the header
 * entry point, with the selected profile inside that captured route's own
 * `?profile=` parameter. Both are normalised on the server before the form ever
 * shows them, so what the user is asked to approve is exactly what will be stored.
 */
import { pageReadErrorMessage } from '../../server/authenticated-page-read';

import { redirect } from 'next/navigation';

import type { FeedbackType } from '@wizard-ads/db';

import { authenticationDestination } from '../../server/request-context';

import { requireOrgRole } from '../../server/org-role';

import { pageContext, profileIdFromRoute } from '../../feedback/page-context';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const single = (value: string | string[] | undefined): string | null =>
  typeof value === 'string' ? value : null;

export async function load(access: ScreenActor, input: ScreenParams) {
  const searchParams = Promise.resolve(input.searchParams) as { searchParams: SearchParams; }['searchParams'];

  try {
    return await access.read(async (database, actor) => {
      await requireOrgRole(database, actor);
      const query = await searchParams;
      const route = single(query['from']);
      const requestedType = single(query['type']);
      const preselectedType: FeedbackType | undefined =
        requestedType === 'bug' || requestedType === 'feature' ? requestedType : undefined;
      const context = pageContext({
        route,
        profileId: profileIdFromRoute(route),
        appVersion: process.env['WIZARD_ADS_APP_VERSION'] ?? null,
        actorType: 'user',
      });
      return { view: 'ready' as const, props: { context, preselectedType } };
    });
  } catch (error) {
    // A page, not an API: an anonymous reporter gets the login screen rather
    // than an instruction to sign in with nowhere to do it.
    const authDestination = authenticationDestination(error);
    if (authDestination !== null) redirect(authDestination);
    const message = pageReadErrorMessage(error, 'Feedback is unavailable');
    return { view: 'error' as const, props: { message } };
  }
}
