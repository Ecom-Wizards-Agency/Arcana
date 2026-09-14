import type { RequestDatabase } from '@wizard-ads/db';
import type { OrgActor } from '@wizard-ads/shared';
import { optimizerMutationError } from '../optimizer/mutation-http';
import { privateResponse } from './private-response';
import { openWebDatabase, requestActor } from './request-context';

/** HTTP resource ownership only; the complete domain operation locks authority. */
export async function optimizerMutation(
  request: Request,
  operation: (database: RequestDatabase, actor: OrgActor) => Promise<Response>,
  failure: (error: unknown) => Response = optimizerMutationError,
): Promise<Response> {
  try {
    const actor = await requestActor(request.headers);
    const database = openWebDatabase();
    let response: Response;
    try {
      // The complete domain command owns one transaction and
      // locks current editor authority before admission. No separate preflight.
      response = await operation(database, actor);
    }
    finally { await database.close(); }
    return privateResponse(response);
  } catch (error) { return privateResponse(failure(error)); }
}

export { optimizerMutationError } from '../optimizer/mutation-http';
