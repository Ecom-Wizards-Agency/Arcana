import { CampaignCreationPreviewError } from '@wizard-ads/db/campaign-creation-previews';
import { CampaignCreationApprovalRequest } from '@wizard-ads/shared/campaign-creation-approval';
import { loadCampaignCreationApproval } from '../../../../src/campaigns/creation-approval-loader';
import { errorResponse, RequestAuthError } from '../../../../src/server/request-context';

export const runtime = 'nodejs';

/** Recorded read only. No generator, recorder, approval or dispatch route is exposed. */
export async function GET(request: Request): Promise<Response> {
  let response: Response;
  try {
    const params = new URL(request.url).searchParams;
    const parsed = CampaignCreationApprovalRequest.safeParse(Object.fromEntries(params));
    const keys = [...params.keys()];
    if (keys.some((key) => key !== 'profileId' && key !== 'planId')
      || keys.length !== new Set(keys).size || !parsed.success) {
      throw new CampaignCreationPreviewError('invalid_request');
    }
    response = Response.json(await loadCampaignCreationApproval(request.headers, parsed.data));
  } catch (error) {
    if (error instanceof RequestAuthError) response = errorResponse(error);
    else {
      const code = error instanceof CampaignCreationPreviewError ? error.code : 'unavailable';
      const status = { invalid_request: 400, not_found: 404, authorization_refused: 403,
        identity_conflict: 409, unavailable: 503 }[code];
      response = Response.json({ code }, { status });
    }
  }
  response.headers.set('cache-control', 'no-store');
  return response;
}
