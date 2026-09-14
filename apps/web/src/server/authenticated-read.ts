import { AgencyAccessDenied, withAuthenticatedReadSnapshot, type AuthenticatedReadSnapshot } from '@wizard-ads/db';
import { Uuid, type OrgActor } from '@wizard-ads/shared';
import { errorResponse, openWebDatabase, requestActor, RequestAuthError } from './request-context';
import { privateResponse } from './private-response';

export class ApiReadError extends Error {
  constructor(message: string, readonly status: 400 | 404 = 400) {
    super(message);
    this.name = 'ApiReadError';
  }
}

export function readUuid(value: string | null, label: string): string {
  const parsed = Uuid.safeParse(value);
  if (!parsed.success) throw new ApiReadError(`${label} must be a UUID`);
  return parsed.data;
}

/** One verified actor, one authenticated transaction, and one owned connection. */
export async function authenticatedRead(
  request: Request,
  read: (handle: AuthenticatedReadSnapshot, actor: OrgActor) => Promise<Response>,
  onError?: (error: unknown) => Response | null,
): Promise<Response> {
  try {
    const actor = await requestActor(request.headers);
    const database = openWebDatabase();
    let response: Response;
    try {
      response = await withAuthenticatedReadSnapshot(database, actor, (snapshot) => read(snapshot, actor));
    } finally {
      await database.close();
    }
    return privateResponse(response);
  } catch (error) {
    const mapped = onError?.(error);
    if (mapped) return privateResponse(mapped);
    if (error instanceof AgencyAccessDenied || error instanceof RequestAuthError || error instanceof SyntaxError) {
      return privateResponse(errorResponse(error));
    }
    if (error instanceof ApiReadError) {
      return privateResponse(Response.json({ error: error.message }, { status: error.status }));
    }
    return privateResponse(Response.json({ error: 'Could not load this data. Try again.' }, { status: 503 }));
  }
}
