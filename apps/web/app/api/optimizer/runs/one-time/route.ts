import { createDb, resolveOneTimePreviewReadiness } from '@wizard-ads/db';
import { OneTimePreviewUnavailableReason } from '@wizard-ads/shared';
import { PostgresRecommendationRunStore, RecommendationPreviewError } from '@wizard-ads/worker';
import { RequestAuthError, errorResponse, requestActor } from '../../../../../src/server/request-context';
import { requireCapability } from '../../../../../src/server/org-role';
import { OptimizerPreviewHttpError, readOneTimeRpcPreviewRequest } from '../../../../../src/optimizer/preview-http';
import { oneTimePreviewUnavailableMessage } from '../../../../../src/optimizer/readiness';

export const runtime = 'nodejs';

/** Separate endpoint: old web versions cannot silently discard explicit run settings. */
export async function POST(request: Request): Promise<Response> {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) return Response.json({ error: 'Database is not configured' }, { status: 503 });
  const database = createDb({ connectionString, max: 1, statementTimeoutSeconds: 15 });
  let unavailableReason: OneTimePreviewUnavailableReason = 'worker_unavailable';
  try {
    const actor = await requestActor(request.headers);
    await requireCapability(database, actor, 'editTargets');
    const body = await readOneTimeRpcPreviewRequest(request);
    const readiness = await resolveOneTimePreviewReadiness(database);
    if (!readiness.ready) unavailableReason = readiness.reason;
    // The store can reconcile an existing request even when new admission is paused.
    // The database independently rechecks runtime readiness when inserting a new job.
    const accepted = await new PostgresRecommendationRunStore(database).enqueueRecommendationPreviewBatch({
      orgId: actor.orgId, actorId: actor.userId, profileId: body.profileId,
      clientRequestId: body.clientRequestId, scope: body.scope,
      oneTimeConfiguration: body.configuration, oneTimeReadiness: readiness,
    });
    return Response.json({ ...accepted, mode: 'fenced' }, { status: 202, headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    if (error instanceof OptimizerPreviewHttpError) return Response.json({ error: error.message }, { status: error.status });
    if (error instanceof RequestAuthError) return errorResponse(error);
    if (error instanceof RecommendationPreviewError && error.code !== 'worker_unavailable') {
      return Response.json({ error: error.message, code: error.code }, { status: error.httpStatus });
    }
    const databaseUnavailable = error instanceof Error && error.message.startsWith('one-time recommendation unavailable: ');
    if (databaseUnavailable || (error instanceof RecommendationPreviewError && error.code === 'worker_unavailable')) {
      if (databaseUnavailable) {
        const parsed = OneTimePreviewUnavailableReason.safeParse(error.message.slice('one-time recommendation unavailable: '.length));
        if (parsed.success) unavailableReason = parsed.data;
      }
      return Response.json({ error: oneTimePreviewUnavailableMessage(unavailableReason), reason: unavailableReason }, { status: 503 });
    }
    return Response.json({ error: 'The preview request could not be reconciled. Retry with the same settings to check its saved status.' }, { status: 503 });
  } finally { await database.close(); }
}
