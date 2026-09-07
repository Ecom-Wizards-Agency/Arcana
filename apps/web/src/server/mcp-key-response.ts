import { McpKeyCommandError } from '@wizard-ads/db';
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
  return mcpKeyResponse(error instanceof McpKeyCommandError
    ? Response.json({ error: error.message }, { status: error.code === 'invalid' ? 400 : 503 })
    : errorResponse(error));
}
