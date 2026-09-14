import type { ScreenActor } from '../../server/page-read';

import type { ScreenParams } from '../types';

/**
 * Start a new experiment.
 *
 * A grid selection arrives as query parameters — `?profile=…&campaigns=…` or
 * `&targets=…` — put there by the "Start an experiment" action on the data grid,
 * so the scope is pre-filled from what the operator had in view. The parameters
 * are normalised on the server before the form ever shows them, so what the user
 * is asked to approve is exactly what will be stored.
 */
import { pageReadErrorMessage } from '../../server/authenticated-page-read';

import { redirect } from 'next/navigation';

import { authenticationDestination } from '../../server/request-context';

import { requireCapability } from '../../server/org-role';

import { idList } from '../../experiments/http';

import {
  listExperimentScopeOptions,
  listProfileOptions,
  selectProfileId,
} from '../../experiments/data';

import type { PrefilledScope } from '../../../app/experiments/new/form';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const single = (value: string | string[] | undefined): string | null =>
  typeof value === 'string' ? value : null;

export async function load(access: ScreenActor, input: ScreenParams) {
  const searchParams = Promise.resolve(input.searchParams) as { searchParams: SearchParams; }['searchParams'];

  try {
    return await access.read(async (database, actor) => {
      // Filing an experiment needs the capability, so refuse a viewer here rather
      // than letting them fill a form the API will reject.
      await requireCapability(database, actor, 'manageExperiments');
      const query = await searchParams;
      const profiles = await listProfileOptions(database, actor.orgId);
      const selectedProfileId = selectProfileId(profiles, single(query['profile']));
      const scopeOptions =
        selectedProfileId === null
          ? { campaigns: [], products: [] }
          : await listExperimentScopeOptions(database, {
            orgId: actor.orgId,
            profileId: selectedProfileId,
          });

      const scope: PrefilledScope = {
        campaignIds: idList(query['campaigns']) ?? [],
        adGroupIds: idList(query['adgroups']) ?? [],
        targetIds: idList(query['targets']) ?? [],
        asins: idList(query['asins']) ?? [],
        searchTerms: idList(query['terms']) ?? [],
      };

      return { view: 'ready' as const, props: { profiles, selectedProfileId, query, scope, scopeOptions } };
    });
  } catch (error) {
    const authDestination = authenticationDestination(error);
    if (authDestination !== null) redirect(authDestination);
    const message = pageReadErrorMessage(error, 'Experiments are unavailable');
    return { view: 'error' as const, props: { message } };
  }
}
