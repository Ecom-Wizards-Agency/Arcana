import { PostgresManualRecommendationAdmission } from '@wizard-ads/worker';
import { readOptimizerPreviewRequest } from '../../../../src/optimizer/preview-http';
import { optimizerMutation } from '../../../../src/optimizer/mutation-http';
import {
  OPTIMIZER_PREVIEW_UNAVAILABLE_MESSAGE,
  resolveOptimizerPreviewReadiness,
} from '../../../../src/optimizer/readiness';

export const runtime = 'nodejs';

/** Queue one read-only, immutable campaign-scoped recommendation preview batch. */
export async function POST(request: Request): Promise<Response> {
  return optimizerMutation(request, async (database, actor) => {
    const body = await readOptimizerPreviewRequest(request);
    // An unset flag after cutover cannot reopen the legacy lane. New job
    // admission is also checked by the database inside the domain transaction.
    const readiness = await resolveOptimizerPreviewReadiness(database);
    if (!readiness.ready) {
      return Response.json(
        { error: OPTIMIZER_PREVIEW_UNAVAILABLE_MESSAGE, reason: readiness.reason },
        { status: 503 },
      );
    }
    const accepted = await new PostgresManualRecommendationAdmission(database).enqueuePreviewBatch(actor, body);
    return Response.json({ ...accepted, mode: readiness.mode }, { status: 202 });
  });
}
