import { AgencyAccessDenied } from '@wizard-ads/db';
import { errorResponse, RequestAuthError } from './request-context';

/** Only explicit request validation messages may be sent to an artifact caller. */
export class DownloadRequestError extends Error {
  constructor(message: string, readonly status: 400 | 404 = 400) {
    super(message);
    this.name = 'DownloadRequestError';
  }
}

/** Apply to errors as well as files: authorization is rechecked on every fetch. */
export function downloadResponse(response: Response): Response {
  response.headers.set('Cache-Control', 'private, no-store, max-age=0');
  const vary = new Set((response.headers.get('Vary') ?? '').split(',').map((value) => value.trim()).filter(Boolean));
  vary.add('Cookie');
  vary.add('Authorization');
  response.headers.set('Vary', [...vary].join(', '));
  response.headers.set('X-Content-Type-Options', 'nosniff');
  return response;
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
