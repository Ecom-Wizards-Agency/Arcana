/**
 * Accept, dismiss or re-open proposals — one, or a filtered set in bulk.
 *
 * Bulk is the point. The recon calls bulk edit over a filtered preview "the
 * single most valuable interaction in the product" (`https://github.com/Ecom-Wizards-Agency/Arcana/blob/dd4f3887f626128250abee537f374712ca42717c/tools/recon/04-optimizer.md` §3), so
 * the client sends the ids its current filter resolved to and this route takes
 * them as one decision with one note. The note is mandatory on a dismissal and
 * recorded either way; `decideRecommendationsForActor` refuses an empty one.
 */
import { decideRecommendationsForActor } from '@wizard-ads/db';
import type { RecommendationDecision } from '@wizard-ads/db';
import { authenticatedMutation, mutationBody, mutationUuid, MutationInputError } from '../../../../src/server/authenticated-mutation';

export const runtime = 'nodejs';

const DECISIONS: readonly string[] = ['accepted', 'dismissed', 'proposed'];

export async function POST(request: Request): Promise<Response> {
  return authenticatedMutation(request, async (database) => {
    // Deciding a proposal is exactly what `editTargets` means, and it is the
    // same role set the `recommendations` update policy grants.

    const body = (await mutationBody(request)) as {
      ids?: unknown;
      decision?: unknown;
      note?: unknown;
    };
    if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== 'string')) {
      throw new MutationInputError('ids must be an array of proposal ids');
    }
    if (typeof body.decision !== 'string' || !DECISIONS.includes(body.decision)) {
      throw new MutationInputError(`decision must be one of: ${DECISIONS.join(', ')}`);
    }
    for (const id of body.ids) mutationUuid(id, 'proposal id');
    const note = typeof body.note === 'string' ? body.note : null;
    if (body.decision === 'dismissed' && !note?.trim()) throw new MutationInputError('A dismissal needs a note.');

    const result = await decideRecommendationsForActor(database, {
      ids: body.ids as string[],
      decision: body.decision as RecommendationDecision,
      note,
    });
    // Offered against changed: a bulk decision that silently moved fewer rows
    // than it was given is the failure mode worth naming in the response.
    return Response.json({ ...result, offered: (body.ids as string[]).length });
  });
}
