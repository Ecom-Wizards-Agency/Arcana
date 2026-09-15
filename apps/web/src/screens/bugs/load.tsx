import type { ScreenActor } from '../../server/page-read';

import type { ScreenParams } from '../types';

/** The tenant-visible bug board, projected from feedback items. */
import { pageReadErrorMessage } from '../../server/authenticated-page-read';

import { redirect } from 'next/navigation';

import { listBugBoard } from '@wizard-ads/db';

import { toUiItem } from '../../feedback/ui';

import { requireOrgRole } from '../../server/org-role';

import { authenticationDestination } from '../../server/request-context';

export async function load(access: ScreenActor, _input: ScreenParams) {

  try {
    return await access.read(async (database, actor) => {
      const role = await requireOrgRole(database, actor);
      const board = await listBugBoard(database, { orgId: actor.orgId, viewerId: actor.userId });
      const map = (items: typeof board.open) => items.map((item) => toUiItem(item, actor.userId));
      return { view: 'ready' as const, props: { map, board, role } };
    });
  } catch (error) {
    const authDestination = authenticationDestination(error);
    if (authDestination !== null) redirect(authDestination);
    const message = pageReadErrorMessage(error, 'The bug board is unavailable');
    return { view: 'error' as const, props: { message } };
  }
}
