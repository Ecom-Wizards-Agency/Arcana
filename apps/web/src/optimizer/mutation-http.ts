import { AgencyAccessDenied, OptimizationGroupPersistenceError, withAuthenticatedActor, type RequestDatabase } from '@wizard-ads/db';
import type { OrgActor } from '@wizard-ads/shared';
import { RecommendationPreviewError } from '@wizard-ads/worker';
import { MutationInputError } from '../server/authenticated-mutation';
import { privateResponse } from '../server/private-response';
import { errorResponse, openWebDatabase, requestActor, RequestAuthError } from '../server/request-context';
import { requireCapability } from '../server/org-role';
import { OptimizerPreviewHttpError } from './preview-http';

/** HTTP resource ownership only; the complete domain operation locks authority. */
export async function optimizerMutation(
  request: Request,
  operation: (database: RequestDatabase, actor: OrgActor) => Promise<Response>,
  failure: (error: unknown) => Response = optimizerMutationError,
): Promise<Response> {
  try {
    const actor = await requestActor(request.headers);
    const database = openWebDatabase();
    let response: Response;
    try {
      // Fast, authenticated refusal before readiness/body work; the domain
      // independently locks and rechecks current authority before mutation.
      await withAuthenticatedActor(database, actor, (sql) => requireCapability({ sql }, actor, 'editTargets'));
      response = await operation(database, actor);
    }
    finally { await database.close(); }
    return privateResponse(response);
  } catch (error) { return privateResponse(failure(error)); }
}

export function optimizerMutationError(
  error: unknown,
  unknownMessage = 'The change could not be confirmed. Reload to check its saved status before trying again.',
): Response {
  if (error instanceof AgencyAccessDenied || error instanceof RequestAuthError || error instanceof SyntaxError) {
    return errorResponse(error);
  }
  const sqlError = error !== null && typeof error === 'object'
    ? error as { code?: unknown; message?: unknown; constraint_name?: unknown } : null;
  if (sqlError?.code === '42501' && sqlError.message === 'Resource not found') {
    return Response.json({ error: 'Resource not found' }, { status: 403 });
  }
  if (error instanceof OptimizerPreviewHttpError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof RecommendationPreviewError) {
    return Response.json({ error: error.message, code: error.code }, { status: error.httpStatus });
  }
  if (error instanceof MutationInputError) return Response.json({ error: error.message }, { status: 400 });
  if (error instanceof OptimizationGroupPersistenceError) {
    // These messages are produced by the scoped domain, never by the driver.
    return Response.json({ error: error.message }, { status: /not found|another profile/.test(error.message) ? 404 : 400 });
  }
  if (sqlError?.code === '23505' && sqlError.constraint_name === 'optimization_groups_profile_id_name_key') {
    return Response.json({ error: 'An optimization group already uses that name' }, { status: 409 });
  }
  // Legacy single-group failures have no typed public code. Only fixed domain
  // messages are safe; a driver error must never reach raw errorResponse.
  if (error instanceof Error && error.constructor === Error) {
    if (error.message === 'Advertising profile not found' || error.message === 'Optimization group not found') {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
    if (['Disabled optimization groups cannot be queued', 'Optimization scope has no eligible campaigns',
      'Optimization scope exceeds the campaign limit', 'Profile previews with optimization groups require a partitioned batch'].includes(error.message)) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error.message === 'Optimization scope overlaps a queued or running preview, or its active scope cannot be established') {
      return Response.json({ error: 'This group already has an active preview. Open its saved status before starting another.', code: 'active_run_conflict' }, { status: 409 });
    }
    if (/^\d+ exported recommendations? (?:requires?|is|are) (?:reversion review before another group preview|awaiting complete synchronized evidence; hold and do not compound)$/.test(error.message)) {
      return Response.json({ error: 'Review the synchronized evidence and any required reversion for this group’s earlier export before starting another preview.', code: 'safety_hold' }, { status: 409 });
    }
  }
  return Response.json({ error: unknownMessage }, { status: 503 });
}
