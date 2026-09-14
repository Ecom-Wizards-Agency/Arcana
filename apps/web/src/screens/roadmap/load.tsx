import type { ScreenActor } from '../../server/page-read';

import type { ScreenParams } from '../types';

/**
 * The feature roadmap, arranged by status from request through shipped.
 *
 * It is a view, not a second data set — a card is on the board because its
 * status says so, and it moves when an admin changes that status. Declined
 * items are on the page too, collapsed, with the note that explains them:
 * Telling somebody why their request is not happening is cheaper than letting
 * them ask again in six weeks.
 */
import { pageReadErrorMessage } from '../../server/authenticated-page-read';

import { redirect } from 'next/navigation';

import { listFeedbackItems } from '@wizard-ads/db';

import { authenticationDestination } from '../../server/request-context';

import { requireOrgRole } from '../../server/org-role';

import { toUiItem } from '../../feedback/ui';

export async function load(access: ScreenActor, _input: ScreenParams) {

  try {
    return await access.read(async (database, actor) => {
      const role = await requireOrgRole(database, actor);
      const items = await listFeedbackItems(database, {
        orgId: actor.orgId,
        viewerId: actor.userId,
        type: 'feature',
        sort: 'votes',
      });
      const mapped = items.map((item) => toUiItem(item, actor.userId));
      return { view: 'ready' as const, props: { actor, mapped, role } };
    });
  } catch (error) {
    // A page, not an API: an anonymous visitor gets the login screen.
    const authDestination = authenticationDestination(error);
    if (authDestination !== null) redirect(authDestination);
    const message = pageReadErrorMessage(error, 'The roadmap is unavailable');
    return { view: 'error' as const, props: { message } };
  }
}
