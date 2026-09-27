import { redirect } from 'next/navigation';
import { readCreatorConflict } from '@wizard-ads/db';
import type { ScreenActor } from '../../server/page-read';
import { pageReadErrorMessage } from '../../server/authenticated-page-read';
import { authenticationDestination } from '../../server/request-context';
import { requireOrgRole } from '../../server/org-role';
import { creatorRecordParam } from '../creators-record/record-id';
import type { ScreenParams } from '../types';

/** `/creators/conflicts/[id]`: a record locked in Conflict beside every record it collides with. Read only; nothing here may act. */
export async function load(access: ScreenActor, input: ScreenParams) {
  const id = creatorRecordParam(input.params['id']);
  try {
    return await access.read(async (database, actor) => {
      const role = await requireOrgRole(database, actor);
      if (role === 'viewer') return { view: 'gated' as const, props: {} };
      const detail = id === null ? null : await readCreatorConflict(database, actor.orgId, id);
      if (detail === null) return { view: 'missing' as const, props: { id } };
      return { view: 'ready' as const, props: { detail } };
    });
  } catch (error) {
    const destination = authenticationDestination(error);
    if (destination !== null) redirect(destination);
    return { view: 'error' as const, props: { message: pageReadErrorMessage(error, 'The creator conflict is unavailable') } };
  }
}
