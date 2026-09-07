import { AgencyAccessDenied } from '@wizard-ads/db';
import { errorResponse, RequestAuthError } from './request-context';
import { privateResponse as downloadResponse } from './private-response';
export { privateResponse as downloadResponse } from './private-response';

/** Only explicit request validation messages may be sent to an artifact caller. */
export class DownloadRequestError extends Error {
  constructor(message: string, readonly status: 400 | 404 = 400) {
    super(message);
    this.name = 'DownloadRequestError';
  }
}

export function downloadErrorResponse(error: unknown): Response {
  if (error instanceof AgencyAccessDenied || error instanceof RequestAuthError || error instanceof SyntaxError) {
    return downloadResponse(errorResponse(error));
  }
  if (error instanceof DownloadRequestError) {
    return downloadResponse(Response.json({ error: error.message }, { status: error.status }));
  }
  // Driver/provider errors can contain SQL, identifiers or stored tenant data.
  return downloadResponse(Response.json({ error: 'The file could not be prepared. Try again.' }, { status: 503 }));
}
