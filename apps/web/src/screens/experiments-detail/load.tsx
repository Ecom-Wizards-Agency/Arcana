import type { ScreenActor } from '../../server/page-read';

import type { ScreenParams } from '../types';

/**
 * `/experiments/[id]` — one experiment, whole.
 *
 * Everything the operator needs to run and read a test in one place: its status
 * and the moves it can make next, a trend chart with the test window shaded, the
 * before / during / after comparison derived from the facts, what actually
 * changed inside the window (from `entity_changes`), and the transition log.
 *
 * The comparison is honest about what it is — a rough measurement against the
 * rest of the account, not a randomized test — and the note on it says so.
 */
import { pageReadErrorMessage } from '../../server/authenticated-page-read';

import type { QueryHandle } from '@wizard-ads/db';

import type { OrgActor } from '@wizard-ads/shared';

import { notFound, redirect } from 'next/navigation';

import {
  computeComparison,
  getExperiment,
  listEntityChangesInWindow,
  listExperimentEvents,
} from '@wizard-ads/db';

import { authenticationDestination } from '../../server/request-context';

import { requireOrgRole } from '../../server/org-role';

import { can } from '../../auth/roles';

import { listProfileOptions, loadExperimentSpendSeries } from '../../experiments/data';

import type { ExperimentDetail } from '../../../app/experiments/[experimentId]/detail';

type RouteParams = Promise<{ experimentId: string; }>;

type DetailProps = Parameters<typeof ExperimentDetail>[0];

export async function load(access: ScreenActor, input: ScreenParams) {
  const params = Promise.resolve(input.params) as RouteParams;

  const { experimentId } = await params;
  let detail: DetailProps | null;
  try {
    detail = await access.read((database, actor) => loadDetail(database, actor, experimentId));
  } catch (error) {
    const authDestination = authenticationDestination(error);
    if (authDestination !== null) redirect(authDestination);
    const message = pageReadErrorMessage(error, 'Experiment is unavailable');
    return { view: 'error' as const, props: { message } };
  }

  // Outside the try on purpose. `notFound()` works by throwing a control-flow
  // error for the framework to catch; called inside, the catch above swallowed
  // it and rendered its digest string as the error message — a 404 that read
  // like a crash.
  if (detail === null) notFound();
  return { view: 'ready' as const, props: { detail } };
}

async function loadDetail(
  database: QueryHandle,
  actor: OrgActor,
  experimentId: string,
): Promise<DetailProps | null> {
  const role = await requireOrgRole(database, actor);
  const experiment = await getExperiment(database, { orgId: actor.orgId, experimentId });
  if (!experiment) return null;

  const now = new Date();
  const [comparison, changes, events, profiles] = await Promise.all([
    computeComparison(database, experiment, now),
    listEntityChangesInWindow(database, experiment, now),
    listExperimentEvents(database, { orgId: actor.orgId, experimentId }),
    listProfileOptions(database, actor.orgId),
  ]);

  const currencyCode = profiles.find((profile) => profile.id === experiment.profileId)?.currencyCode ?? 'USD';

  const spanStart = comparison.windows[0]?.start ?? experiment.startAt.toISOString().slice(0, 10);
  const spanEnd = comparison.windows[comparison.windows.length - 1]?.end ?? now.toISOString().slice(0, 10);
  const trend = await loadExperimentSpendSeries(database, {
    orgId: actor.orgId,
    profileId: experiment.profileId,
    start: spanStart,
    end: spanEnd,
    ...(experiment.scope.campaignIds ? { campaignIds: experiment.scope.campaignIds } : {}),
    ...(experiment.scope.targetIds ? { targetIds: experiment.scope.targetIds } : {}),
  });

  return {
    experiment: {
      id: experiment.id,
      profileId: experiment.profileId,
      name: experiment.name,
      hypothesis: experiment.hypothesis,
      type: experiment.type,
      metricFocus: experiment.metricFocus,
      status: experiment.status,
      scope: experiment.scope,
      resultNote: experiment.resultNote,
      startAt: experiment.startAt.toISOString(),
      endAt: experiment.endAt ? experiment.endAt.toISOString() : null,
    },
    comparison,
    changes: changes.map((change) => ({
      id: change.id,
      entityType: change.entityType,
      amazonId: change.amazonId,
      entityName: change.entityName,
      field: change.field,
      oldValue: change.oldValue,
      newValue: change.newValue,
      source: change.source,
      observedAt: change.observedAt.toISOString(),
    })),
    events: events.map((event) => ({
      id: event.id,
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      note: event.note,
      actorId: event.actorId,
      systemActor: event.systemActor,
      createdAt: event.createdAt.toISOString(),
    })),
    trend,
    currencyCode,
    canManage: can(role, 'manageExperiments'),
  };
}
