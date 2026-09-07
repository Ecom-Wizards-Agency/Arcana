import {
  AgencyAccessDenied, GotoInputError, TagInputError, TagNotFoundError,
  withAuthenticatedOrgEditor, type AuthenticatedEditorTransaction,
} from '@wizard-ads/db';
import { Uuid } from '@wizard-ads/shared';
import { errorResponse, openWebDatabase, requestActor, RequestAuthError } from './request-context';
import { privateResponse } from './private-response';

export class MutationInputError extends Error {}

export async function mutationBody(request: Request): Promise<Record<string, unknown>> {
  const value: unknown = await request.json();
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new MutationInputError('A JSON object is required');
  }
  return value as Record<string, unknown>;
}

export function mutationUuid(value: unknown, field: string): string {
  const parsed = Uuid.safeParse(value);
  if (!parsed.success) throw new MutationInputError(`${field} must be a valid ID`);
  return parsed.data;
}

/** One authenticated editor transaction, including response serialization. */
export async function authenticatedMutation(
  request: Request,
  mutate: (context: AuthenticatedEditorTransaction) => Promise<Response>,
): Promise<Response> {
  try {
    const actor = await requestActor(request.headers);
    const database = openWebDatabase();
    let response: Response;
    try {
      response = await withAuthenticatedOrgEditor(database, actor, async (context) =>
        privateResponse(await mutate(context)));
    } finally {
      await database.close();
    }
    return response;
  } catch (error) {
    if (error instanceof RequestAuthError || error instanceof SyntaxError) {
      return privateResponse(errorResponse(error));
    }
    const sqlError = error !== null && typeof error === 'object'
      ? error as { code?: unknown; message?: unknown; constraint_name?: unknown } : null;
    if (error instanceof AgencyAccessDenied || (sqlError?.code === '42501' && sqlError.message === 'Resource not found')) {
      return privateResponse(Response.json({ error: 'Resource not found' }, { status: 403 }));
    }
    if (error instanceof TagNotFoundError) {
      return privateResponse(Response.json({ error: 'Not found' }, { status: 404 }));
    }
    if (error instanceof MutationInputError || error instanceof TagInputError || error instanceof GotoInputError) {
      return privateResponse(Response.json({ error: error.message }, { status: 400 }));
    }
    if (sqlError?.code === '23505' && sqlError.constraint_name === 'tags_sibling_slug_key') {
      return privateResponse(Response.json({ error: 'A sibling tag already uses that name' }, { status: 409 }));
    }
    // A commit can precede a failed close or lost acknowledgement. Never retry
    // here: creating a signed link again would create a second durable token.
    return privateResponse(Response.json({ error: 'The save could not be confirmed. Reload before trying again.' }, { status: 503 }));
  }
}
