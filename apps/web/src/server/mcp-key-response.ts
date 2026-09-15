import { AgencyAccessDenied, McpKeyCommandError } from '@wizard-ads/db';
import { MutationInputError } from './authenticated-mutation';
import { authOrigin } from '../auth/origin';
import { errorResponse, RequestAuthError } from './request-context';

/** Browser key-management actions require the installation's fixed origin. */
export function requireMcpKeyOrigin(request: Request): void {
  if (request.headers.get('origin') !== new URL(authOrigin()).origin) {
    throw new RequestAuthError('Request origin refused', 403);
  }
}

export function mcpKeyResponse(response: Response): Response {
  response.headers.set('Cache-Control', 'no-store, max-age=0');
  response.headers.set('Vary', 'Cookie, Authorization');
  return response;
}

export function mcpKeyError(error: unknown): Response {
  if (error instanceof McpKeyCommandError) return mcpKeyResponse(Response.json(
    { error: error.message }, { status: error.code === 'invalid' ? 400 : 503 }));
  if (error instanceof MutationInputError) return mcpKeyResponse(Response.json({ error: error.message }, { status: error.status }));
  if (error instanceof RequestAuthError || error instanceof SyntaxError || error instanceof AgencyAccessDenied) {
    return mcpKeyResponse(errorResponse(error));
  }
  return mcpKeyResponse(Response.json({ error: 'The key operation could not be confirmed. Refresh the key list before trying again.' }, { status: 503 }));
}
