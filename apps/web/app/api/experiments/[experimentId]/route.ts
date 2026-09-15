/**
 * One experiment: read it, move its status, or edit its fields.
 *
 * Writes hold current editor membership and check `manageExperiments` in the
 * same authenticated transaction as the command and its parsed readback.
 * An analyst may edit their own experiments; owners/admins may edit any in
 * the selected agency. RLS also constrains every query in the transaction.
 */
import { getExperiment, listExperimentEvents, listExperimentInferredBatchNotes, mutateExperimentForActor } from '@wizard-ads/db';
import { authenticatedRead, readUuid } from '../../../../src/server/authenticated-read';
import { authenticatedMutation, mutationBody } from '../../../../src/server/authenticated-mutation';
import { experimentCommand, experimentErrorResponse, experimentMutationResponse } from '../../../../src/experiments/http';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ experimentId: string }> };

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  return authenticatedRead(request, async (database, actor) => {
    const { experimentId } = await context.params;
    readUuid(experimentId, 'experimentId');
    const item = await getExperiment(database, { orgId: actor.orgId, experimentId });
    if (!item) return Response.json({ error: 'Experiment not found' }, { status: 404 });
    const events = await listExperimentEvents(database,{orgId:actor.orgId,experimentId});
    const inferredBatchNotes = await listExperimentInferredBatchNotes(database, {orgId:actor.orgId,experimentId});
    return Response.json({ item, events, inferredBatchNotes });
  });
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  return authenticatedMutation(request, async (transaction) => {
    const { experimentId } = await context.params;
    const command = experimentCommand(await mutationBody(request), experimentId);
    return experimentMutationResponse(await mutateExperimentForActor(transaction, transaction.actor, command));
  }, experimentErrorResponse);
}
