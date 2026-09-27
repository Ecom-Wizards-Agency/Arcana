/**
 * Decide one creator reply draft: approve it, mark it sent by hand, or withdraw it.
 *
 * Approving records a decision and sends nothing: the operator sends the text by
 * hand in Amazon. The database trigger checks the transition, the current
 * owner/admin role and the Conflict lock, stamps who and when from the session,
 * and appends the action-log entry in the same statement. Scoped to the actor's
 * org, so a draft id from another tenant is not found rather than touched.
 */
import { AgencyAccessDenied, CreatorWriteRefusal, transitionCreatorDraft } from '@wizard-ads/db';
import { Uuid } from '@wizard-ads/shared';
import { MutationInputError, mutationBody } from '../../../../src/server/authenticated-mutation';
import { requireMcpKeyOrigin } from '../../../../src/server/mcp-key-response';
import { privateResponse } from '../../../../src/server/private-response';
import { errorResponse, openWebDatabase, requestActor, RequestAuthError } from '../../../../src/server/request-context';

export const runtime = 'nodejs';

type RouteContext = { params: Promise<{ draftId: string }> };
const MOVES = ['approved', 'sent_by_hand', 'withdrawn'] as const;
type Move = typeof MOVES[number];

function draftError(error: unknown): Response {
  if (error instanceof CreatorWriteRefusal) {
    return privateResponse(Response.json({ error: error.message, code: error.code }, { status: error.code === 'draft_not_found' ? 404 : 409 }));
  }
  if (error instanceof MutationInputError) return privateResponse(Response.json({ error: error.message }, { status: error.status }));
  if (error instanceof RequestAuthError || error instanceof SyntaxError || error instanceof AgencyAccessDenied) {
    return privateResponse(errorResponse(error));
  }
  return privateResponse(Response.json({ error: 'The draft change could not be confirmed. Reload the drafts before trying again.' }, { status: 503 }));
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    requireMcpKeyOrigin(request);
    const actor = await requestActor(request.headers);
    const { draftId } = await context.params;
    if (!Uuid.safeParse(draftId).success) throw new MutationInputError('Draft not found', 404);
    const body = await mutationBody(request);
    const to = body['to'];
    if (typeof to !== 'string' || !(MOVES as readonly string[]).includes(to)) {
      throw new MutationInputError('to must be approved, sent_by_hand or withdrawn');
    }
    // transitionCreatorDraft owns the single authenticated transaction.
    const database = openWebDatabase();
    try {
      const draft = await transitionCreatorDraft(database, actor, draftId, to as Move);
      return privateResponse(Response.json({ draft }));
    } finally { await database.close(); }
  } catch (error) {
    return draftError(error);
  }
}
