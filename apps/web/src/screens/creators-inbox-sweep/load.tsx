import { redirect } from 'next/navigation';
import { readCreatorSweeps } from '@wizard-ads/db';
import type { ScreenActor } from '../../server/page-read';
import { pageReadErrorMessage } from '../../server/authenticated-page-read';
import { authenticationDestination } from '../../server/request-context';
import { requireOrgRole } from '../../server/org-role';
import type { ScreenParams } from '../types';

/** `/creators/sweep`: the newest inbox sweep checkpoint and the one before it. */
export async function load(access: ScreenActor, _input: ScreenParams) {
  try {
    return await access.read(async (database, actor) => {
      const role = await requireOrgRole(database, actor);
      if (role === 'viewer') return { view: 'gated' as const, props: {} };
      return { view: 'ready' as const, props: { snapshot: await readCreatorSweeps(database, actor.orgId) } };
    });
  } catch (error) {
    const destination = authenticationDestination(error);
    if (destination !== null) redirect(destination);
    return { view: 'error' as const, props: { message: pageReadErrorMessage(error, 'The inbox sweep is unavailable') } };
  }
}
