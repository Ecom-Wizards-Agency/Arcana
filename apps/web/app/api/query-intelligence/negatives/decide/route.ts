import { decideContextualNegativesForActor } from '@wizard-ads/db';
import { authenticatedMutation } from '../../../../../src/server/authenticated-mutation';
import { parseDecisionRequest, readBoundedReviewJson } from '../../../../../src/query-intelligence/review-http';
import { contextualNegativeReviewErrorResponse } from '../../../../../src/query-intelligence/review-errors';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  return authenticatedMutation(request, async (database) => {
    const body = parseDecisionRequest(await readBoundedReviewJson(request));
    const result = await decideContextualNegativesForActor(database, {
      profileId: body.profileId,
      marketplaceId: body.marketplaceId,
      proposals: body.proposals,
      decision: body.decision,
      note: body.note,
    });
    return Response.json(result);
  }, contextualNegativeReviewErrorResponse);
}
