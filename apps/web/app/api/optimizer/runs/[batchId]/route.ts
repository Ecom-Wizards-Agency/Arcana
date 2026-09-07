import {
  readRecommendationPreviewBatchStatus,
  RecommendationPreviewError,
} from '@wizard-ads/worker';
import { resolveOneTimePreviewReadiness, withAuthenticatedActor } from '@wizard-ads/db';
import {
  errorResponse,
  openWebDatabase,
  RequestAuthError,
  requestActor,
} from '../../../../../src/server/request-context';
import { AgencyAccessDenied } from '@wizard-ads/db';
import { privateResponse } from '../../../../../src/server/private-response';
import {
  OptimizerPreviewHttpError,
  optimizerPreviewUuid,
} from '../../../../../src/optimizer/preview-http';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ batchId: string }> };

/** Read the bounded aggregate status of one tenant-scoped preview batch. */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const actor = await requestActor(request.headers);
    const database = openWebDatabase();
    let response: Response;
    try {
      const status = await withAuthenticatedActor(database, actor, async (sql) => {
        const parameters = await context.params;
        const batchId = optimizerPreviewUuid(parameters.batchId, 'batchId');
        const profileId = optimizerPreviewUuid(
          new URL(request.url).searchParams.get('profileId'),
          'profileId',
        );
        return readRecommendationPreviewBatchStatus({ sql }, {
          orgId: actor.orgId,
          profileId,
          batchId,
        });
      });
      if (status === null) {
        response = Response.json({ error: 'Not found' }, { status: 404 });
      } else {
        // Installation readiness is privileged infrastructure metadata. Read it
        // separately, only after the authenticated tenant result has settled.
        const availability = status.executionSnapshot === undefined
          ? undefined
          : await resolveOneTimePreviewReadiness(database);
        response = Response.json({ ...status, ...(availability === undefined ? {} : { availability }) });
      }
    } finally {
      await database.close();
    }
    return privateResponse(response);
  } catch (error) {
    if (error instanceof OptimizerPreviewHttpError) {
      return privateResponse(Response.json({ error: error.message }, { status: error.status }));
    }
    if (error instanceof RecommendationPreviewError) {
      return privateResponse(Response.json(
        { error: error.message, code: error.code },
        { status: error.httpStatus },
      ));
    }
    if (error instanceof RequestAuthError || error instanceof AgencyAccessDenied) {
      return privateResponse(errorResponse(error));
    }
    return privateResponse(Response.json({ error: 'Could not load preview status. Try again.' }, { status: 503 }));
  }
}
