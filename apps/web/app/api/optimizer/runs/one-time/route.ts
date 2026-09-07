import { resolveOneTimePreviewReadiness } from '@wizard-ads/db';
import { OneTimePreviewUnavailableReason } from '@wizard-ads/shared';
import { PostgresManualRecommendationAdmission, RecommendationPreviewError } from '@wizard-ads/worker';
import { readOneTimeRpcPreviewRequest } from '../../../../../src/optimizer/preview-http';
import { oneTimePreviewUnavailableMessage } from '../../../../../src/optimizer/readiness';
import { optimizerMutation, optimizerMutationError } from '../../../../../src/optimizer/mutation-http';

export const runtime = 'nodejs';

/** Separate endpoint: old web versions cannot silently discard explicit run settings. */
export async function POST(request: Request): Promise<Response> {
  let unavailableReason: OneTimePreviewUnavailableReason = 'worker_unavailable';
  return optimizerMutation(request, async (database, actor) => {
    const body = await readOneTimeRpcPreviewRequest(request);
    const readiness = await resolveOneTimePreviewReadiness(database);
    if (!readiness.ready) unavailableReason = readiness.reason;
    // Reconcile the saved identity even while new admission is unavailable.
    // New jobs independently recheck readiness in the same database transaction.
    const accepted = await new PostgresManualRecommendationAdmission(database).enqueuePreviewBatch(actor, {
      profileId: body.profileId, clientRequestId: body.clientRequestId, scope: body.scope,
      oneTimeConfiguration: body.configuration, oneTimeReadiness: readiness,
    });
    return Response.json({ ...accepted, mode: 'fenced' }, { status: 202 });
  }, (error) => {
    const databaseUnavailable = error instanceof Error && error.message.startsWith('one-time recommendation unavailable: ');
    if (databaseUnavailable || (error instanceof RecommendationPreviewError && error.code === 'worker_unavailable')) {
      if (databaseUnavailable) {
        const parsed = OneTimePreviewUnavailableReason.safeParse(error.message.slice('one-time recommendation unavailable: '.length));
        if (parsed.success) unavailableReason = parsed.data;
      }
      return Response.json({ error: oneTimePreviewUnavailableMessage(unavailableReason), reason: unavailableReason }, { status: 503 });
    }
    return optimizerMutationError(error, 'The preview request could not be reconciled. Retry with the same settings to check its saved status.');
  });
}
