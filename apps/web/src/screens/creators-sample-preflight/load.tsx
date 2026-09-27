import { redirect } from 'next/navigation';
import { readCreatorPreflightDetail } from '@wizard-ads/db';
import type { ScreenActor } from '../../server/page-read';
import { pageReadErrorMessage } from '../../server/authenticated-page-read';
import { authenticationDestination } from '../../server/request-context';
import { requireOrgRole } from '../../server/org-role';
import type { ScreenParams } from '../types';
import { sampleOrderKeyParam } from './order-key';

/**
 * `/creators/samples/[key]/preflight`: the newest recorded pre-flight for one
 * sample lane, read under tenant RLS. `now` is the read time the preview's
 * validity is judged against, so the view stays a pure function of its props.
 */
export async function load(access: ScreenActor, input: ScreenParams) {
  const key = sampleOrderKeyParam(input.params['id']);
  try {
    return await access.read(async (database, actor) => {
      const role = await requireOrgRole(database, actor);
      if (role === 'viewer') return { view: 'gated' as const, props: {} };
      const detail = key === null ? null : await readCreatorPreflightDetail(database, actor.orgId, key);
      if (detail === null) return { view: 'missing' as const, props: { key } };
      return { view: 'ready' as const, props: { detail, now: new Date().toISOString() } };
    });
  } catch (error) {
    const destination = authenticationDestination(error);
    if (destination !== null) redirect(destination);
    return { view: 'error' as const, props: { message: pageReadErrorMessage(error, 'The sample pre-flight is unavailable') } };
  }
}
