import { PostgresManualRecommendationAdmission } from '@wizard-ads/worker';
import { mutationBody, mutationUuid } from '../../../../../src/server/authenticated-mutation';
import { optimizerMutation } from '../../../../../src/optimizer/mutation-http';
import {
  OPTIMIZER_PREVIEW_UNAVAILABLE_MESSAGE,
  resolveOptimizerPreviewReadiness,
} from '../../../../../src/optimizer/readiness';

export const runtime = 'nodejs';

/** Queue an OpenSpell preview for one group. No Amazon write occurs. */
export async function POST(request: Request): Promise<Response> {
  return optimizerMutation(request, async (database, actor) => {
    const body = await mutationBody(request);
    const profileId = mutationUuid(body['profileId'], 'profileId');
    const groupId = mutationUuid(body['groupId'], 'groupId');
    const readiness = await resolveOptimizerPreviewReadiness(database);
    if (!readiness.ready) {
      return Response.json(
        { error: OPTIMIZER_PREVIEW_UNAVAILABLE_MESSAGE, reason: readiness.reason },
        { status: 503 },
      );
    }
    const queued = await new PostgresManualRecommendationAdmission(database).enqueueGroup(actor, { profileId, groupId });
    return Response.json({ ...queued, mode: readiness.mode }, { status: 202 });
  });
}
