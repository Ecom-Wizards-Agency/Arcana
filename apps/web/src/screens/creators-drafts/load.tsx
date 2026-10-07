import { redirect } from 'next/navigation';
import { readCreatorDrafts } from '@wizard-ads/db';
import type { ScreenActor } from '../../server/page-read';
import { pageReadErrorMessage } from '../../server/authenticated-page-read';
import { authenticationDestination } from '../../server/request-context';
import { requireOrgRole } from '../../server/org-role';
import type { ScreenParams } from '../types';

/**
 * `/creators/drafts`: the newest draft day, read under tenant RLS. Owners and
 * admins may decide a draft; analysts read. Deciding sends nothing.
 */
export async function load(access: ScreenActor, _input: ScreenParams) {
  try {
    return await access.read(async (database, actor) => {
      const role = await requireOrgRole(database, actor);
      if (role === 'viewer') return { view: 'gated' as const, props: {} };
      return { view: 'ready' as const, props: {
        snapshot: await readCreatorDrafts(database, actor.orgId),
        canDecide: role === 'owner' || role === 'admin',
        viewerId: actor.userId,
      } };
    });
  } catch (error) {
    const destination = authenticationDestination(error);
    if (destination !== null) redirect(destination);
    return { view: 'error' as const, props: { message: pageReadErrorMessage(error, 'The reply drafts are unavailable') } };
  }
}
