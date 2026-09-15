import type { ScreenActor } from '../../server/page-read';

import type { ScreenParams } from '../types';

/**
 * `/recommendations` — the review surface for engine proposals.
 *
 * The whole run is loaded and shipped in one payload, like the grid: QA-ing a
 * preview means sorting the set and scanning it, and server-side pagination
 * makes that workflow impossible (`https://github.com/Ecom-Wizards-Agency/Arcana/blob/dd4f3887f626128250abee537f374712ca42717c/tools/recon/02-data-grid.md` §6).
 *
 * The one thing this page does that the incumbent's does not: every proposal
 * arrives carrying the strategy / objective that produced it, resolved against
 * **the run's own doctrine snapshot** rather than today's document. That is the
 * constraint `https://github.com/Ecom-Wizards-Agency/Arcana/blob/dd4f3887f626128250abee537f374712ca42717c/docs/DECISIONS.md` puts on WP-07 so per-campaign strategy
 * assignment lands later as a data change.
 *
 * And the differentiator the brief names: the provenance panel. AdLabs publishes
 * the formula; we publish the numbers that went into this row.
 */
import { pageReadErrorMessage } from '../../server/authenticated-page-read';

import { redirect, unstable_rethrow } from 'next/navigation';

import {
  getRecommendationRun,
  listRecommendationRuns,
  listRecommendations,
} from '@wizard-ads/db';

import { authenticationDestination } from '../../server/request-context';

import { requireOrgRole } from '../../server/org-role';

import { listOrgProfiles } from '../../recommendations/data';

import { toProposalView } from '../../recommendations/view';

import { selectRecommendationRun } from '../../recommendations/runs';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * The safety valve `listRecommendations` applies by default, stated here so the
 * number the queue quotes and the number the query enforces are the same one.
 * The query returns no completeness metadata, so the workspace compares what
 * arrived against the run's own per-status counts and says when it is short.
 */
const RECOMMENDATION_QUEUE_LOAD_CAP = 20_000;

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export async function load(access: ScreenActor, input: ScreenParams) {
  const searchParams = Promise.resolve(input.searchParams) as { searchParams: SearchParams; }['searchParams'];

  try {
    return await access.read(async (database, actor) => {
      const role = await requireOrgRole(database, actor);
      const query = await searchParams;

      const profiles = await listOrgProfiles(database, actor.orgId);
      const requested = await Promise.resolve(access.requestedProfile);
      const profile = access.selectProfile(profiles, requested);
      if (profile === null) {
        return { view: 'empty' as const, props: {} };
      }

      const runs = await listRecommendationRuns(database, {
        orgId: actor.orgId,
        profileId: profile.id,
        limit: 20,
      });
      const requestedRun = one(query['run']);
      const runId = selectRecommendationRun(runs, requestedRun)?.id ?? null;
      const run = runId === null ? null : await getRecommendationRun(database, { orgId: actor.orgId, runId });

      const records =
        run === null || run.status !== 'succeeded'
          ? []
          : await listRecommendations(database, {
            orgId: actor.orgId,
            runId: run.id,
            limit: RECOMMENDATION_QUEUE_LOAD_CAP,
          });
      const proposals = records.map((record) =>
        toProposalView(record, { strategySnapshot: run?.strategySnapshot ?? null, ...(run?.executionSnapshot === undefined ? {} : { executionSnapshot: run.executionSnapshot }) }),
      );

      return { view: 'ready' as const, props: { run, proposals, profile, runs, role } };
    });
  } catch (error) {
    unstable_rethrow(error);
    // Nobody is signed in. A page is not an API: the answer to "who are you" is
    // the login screen, not a 200 that says "Authentication required" and
    // leaves the visitor to find `/login` themselves.
    const authDestination = authenticationDestination(error);
    if (authDestination !== null) redirect(authDestination);
    const message = pageReadErrorMessage(error, 'Recommendations are unavailable');
    return { view: 'error' as const, props: { message } };
  }
}
