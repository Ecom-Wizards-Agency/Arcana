import { CampaignCreationRetryReviewRequest } from '@wizard-ads/shared';
import { CampaignCreationAdmissionError } from '@wizard-ads/db';
import { authenticatedMutation, mutationBody } from '../../../../../src/server/authenticated-mutation';
import { reviewSavedCampaignCreationRetry } from '../../../../../src/campaigns/creation-approval';

export const runtime = 'nodejs';
/** Records fresh retry evidence for display. It admits nothing and never reaches Amazon. */
export async function POST(request: Request): Promise<Response> {
  return authenticatedMutation(request, async (context) => {
    const input = CampaignCreationRetryReviewRequest.safeParse(await mutationBody(request));
    if (!input.success) return Response.json({ code: 'invalid_request', error: 'The exact approved draft and parent batch are required.' }, { status: 400 });
    return Response.json(await reviewSavedCampaignCreationRetry(context, input.data));
  }, (error) => error instanceof CampaignCreationAdmissionError
    ? Response.json({ code: error.code, error: error.message }, { status: error.code === 'not_found' ? 404 : 409 }) : null);
}
