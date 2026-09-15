import { exportContextualNegativesForActor } from '@wizard-ads/db';
import { authenticatedMutation } from '../../../../../src/server/authenticated-mutation';
import { parseExportRequest, readBoundedReviewJson } from '../../../../../src/query-intelligence/review-http';
import { contextualNegativeReviewErrorResponse } from '../../../../../src/query-intelligence/review-errors';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  return authenticatedMutation(request, async (database) => {
    const body = parseExportRequest(await readBoundedReviewJson(request));
    const result = await exportContextualNegativesForActor(database, {
      profileId: body.profileId,
      marketplaceId: body.marketplaceId,
      proposals: body.proposals,
      note: body.note,
    });
    const base = `/api/query-intelligence/negatives/export/${result.exportId}`;
    return Response.json({
      ...result,
      exported: result.stamped,
      downloads: {
        csv: `${base}?format=csv`,
        json: `${base}?format=json`,
      },
      amazonUpdated: false,
    }, { status: 201 });
  }, contextualNegativeReviewErrorResponse);
}
