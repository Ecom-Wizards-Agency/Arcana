import { AgencyAccessDenied, withAuthenticatedActor, type QueryHandle } from '@wizard-ads/db';
import type { OrgActor } from '@wizard-ads/shared';
import { openWebDatabase, requestActor, RequestAuthError } from './request-context';

/** A complete page read owns one connection and exposes only its authenticated transaction. */
export async function authenticatedPageRead<T>(
  headers: Headers,
  read: (handle: QueryHandle, actor: OrgActor) => Promise<T>,
): Promise<T> {
  const actor = await requestActor(headers);
  const database = openWebDatabase();
  try {
    return await withAuthenticatedActor(database, actor, (sql) => read({ sql }, actor));
  } finally {
    await database.close();
  }
}

/** Authentication continuations are handled by the page before this safe fallback. */
export function pageReadErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof AgencyAccessDenied) return 'Resource not found';
  if (error instanceof RequestAuthError) return error.message;
  return fallback;
}
