import { CampaignCreationBatchRequest } from '@wizard-ads/shared';
import { CampaignCreationAdmissionError } from '@wizard-ads/db';
import { authenticatedMutation, mutationBody } from '../../../../src/server/authenticated-mutation';
import { approveSavedCampaignCreation } from '../../../../src/campaigns/creation-approval';

export const runtime = 'nodejs';
export async function POST(request: Request): Promise<Response> {
  return authenticatedMutation(request, async (context) => {
    const input = CampaignCreationBatchRequest.safeParse(await mutationBody(request));
    if (!input.success) return Response.json({ code: 'invalid_request', error: 'The exact saved draft binding is required.' }, { status: 400 });
    return Response.json(await approveSavedCampaignCreation(context, input.data));
  }, (error) => error instanceof CampaignCreationAdmissionError
    ? Response.json({ code: error.code, error: error.message }, { status: error.code === 'not_found' ? 404 : 409 }) : null);
}
