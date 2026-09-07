import { FeedbackCommandError, mutateFeedbackForActor } from '@wizard-ads/db';
import { FeedbackCommand } from '@wizard-ads/shared';
import { MutationInputError, mutationUuid } from '../server/authenticated-mutation';
import { privateResponse } from '../server/private-response';
import { errorResponse, openWebDatabase, requestActor, RequestAuthError } from '../server/request-context';
import { pageContext } from './page-context';

function command(value: unknown): FeedbackCommand {
  const parsed = FeedbackCommand.safeParse(value);
  if (!parsed.success) throw new MutationInputError('Check the feedback fields and try again.');
  return parsed.data;
}

export function feedbackSubmission(body: Record<string, unknown>): FeedbackCommand {
  const value = body['pageContext'];
  const captured = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const context = pageContext({
    route: typeof captured['route'] === 'string' ? captured['route'] : null,
    profileId: typeof captured['profileId'] === 'string' ? captured['profileId'] : null,
    appVersion: typeof captured['appVersion'] === 'string' ? captured['appVersion'] : null,
  });
  return command({ ...body, kind: 'create', pageContext: {
    route: context.route, profileId: context.profileId, appVersion: context.appVersion,
  } });
}

export function feedbackPatch(itemId: string, body: Record<string, unknown>): FeedbackCommand {
  const id = mutationUuid(itemId, 'itemId');
  const duplicate = body['duplicateOf'] !== undefined;
  const triage = body['status'] !== undefined || body['adminNote'] !== undefined || duplicate;
  const edit = body['title'] !== undefined || body['body'] !== undefined || body['severity'] !== undefined;
  if (triage && edit) throw new MutationInputError('Triage and an author edit are separate requests');
  if (duplicate && (body['status'] !== undefined || body['adminNote'] !== undefined)) {
    throw new MutationInputError('Marking a duplicate is a separate triage request');
  }
  if (!triage && !edit) throw new MutationInputError('Nothing to change');
  return command({ ...body, itemId: id, kind: duplicate ? 'duplicate' : triage ? 'triage' : 'edit' });
}

/** One request and one command; no retry after lost commit, serialization or close. */
export async function feedbackMutationResponse(
  request: Request,
  prepare: () => FeedbackCommand | Promise<FeedbackCommand>,
): Promise<Response> {
  try {
    const actor = await requestActor(request.headers);
    const input = await prepare();
    const database = openWebDatabase();
    let response: Response;
    try {
      const result = await mutateFeedbackForActor(database, actor, input);
      response = result.kind === 'vote'
        ? Response.json({ itemId: result.itemId, voted: result.voted, votes: result.votes })
        : Response.json({ item: result.item }, { status: result.kind === 'created' ? 201 : 200 });
    } finally { await database.close(); }
    return privateResponse(response);
  } catch (error) {
    if (error instanceof RequestAuthError || error instanceof SyntaxError) return privateResponse(errorResponse(error));
    if (error instanceof MutationInputError) return privateResponse(Response.json({ error: error.message }, { status: 400 }));
    if (error instanceof FeedbackCommandError) {
      const status = { invalid: 400, not_found: 404, forbidden: 403, unconfirmed: 503 }[error.code];
      return privateResponse(Response.json({ error: error.message, code: error.code }, { status }));
    }
    return privateResponse(Response.json({
      error: 'The save could not be confirmed. Reload before trying again.', code: 'unconfirmed',
    }, { status: 503 }));
  }
}
