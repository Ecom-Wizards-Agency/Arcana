import { redirect } from 'next/navigation';
import { readCreatorProductSwitch } from '@wizard-ads/db';
import type { ScreenActor } from '../../server/page-read';
import { pageReadErrorMessage } from '../../server/authenticated-page-read';
import { authenticationDestination } from '../../server/request-context';
import { requireOrgRole } from '../../server/org-role';
import type { ScreenParams } from '../types';
import { sampleOrderKeyParam } from '../creators-sample-preflight/order-key';

/**
 * `/creators/samples/[id]/product-switch`: the original lane's derived order key, why that lane cannot ship,
 * and every alternate the runner checked in live stock, read under tenant RLS.
 */
export async function load(access: ScreenActor, input: ScreenParams) {
  const key = sampleOrderKeyParam(input.params['id']);
  try {
    return await access.read(async (database, actor) => {
      const role = await requireOrgRole(database, actor);
      if (role === 'viewer') return { view: 'gated' as const, props: {} };
      const detail = key === null ? null : await readCreatorProductSwitch(database, actor.orgId, key);
      if (detail === null) return { view: 'missing' as const, props: { key } };
      return { view: 'ready' as const, props: { detail } };
    });
  } catch (error) {
    const destination = authenticationDestination(error);
    if (destination !== null) redirect(destination);
    return { view: 'error' as const, props: { message: pageReadErrorMessage(error, 'The product switch is unavailable') } };
  }
}
