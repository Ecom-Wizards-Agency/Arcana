import { redirect } from 'next/navigation';
import { readCreatorRecord } from '@wizard-ads/db';
import type { ScreenActor } from '../../server/page-read';
import { pageReadErrorMessage } from '../../server/authenticated-page-read';
import { authenticationDestination } from '../../server/request-context';
import { requireOrgRole } from '../../server/org-role';
import type { ScreenParams } from '../types';
import { creatorRecordParam } from './record-id';

/** `/creators/records/[id]`: one registry record, its identity, score, queue row and everything since, read under tenant RLS. */
export async function load(access: ScreenActor, input: ScreenParams) {
  const id = creatorRecordParam(input.params['id']);
  try {
    return await access.read(async (database, actor) => {
      const role = await requireOrgRole(database, actor);
      if (role === 'viewer') return { view: 'gated' as const, props: {} };
      const detail = id === null ? null : await readCreatorRecord(database, actor.orgId, id);
      if (detail === null) return { view: 'missing' as const, props: { id } };
      return { view: 'ready' as const, props: { detail, canDecide: role === 'owner' || role === 'admin' } };
    });
  } catch (error) {
    const destination = authenticationDestination(error);
    if (destination !== null) redirect(destination);
    return { view: 'error' as const, props: { message: pageReadErrorMessage(error, 'The creator record is unavailable') } };
  }
}
