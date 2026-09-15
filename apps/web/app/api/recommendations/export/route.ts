/**
 * Export accepted proposals as a staged-apply batch.
 *
 * This is v1's whole apply path and it writes nothing to Amazon: the batch and
 * its rows land in our ledger, the proposals move to `exported`, and the files
 * are produced from the stored rows by the download route next door. Splitting
 * "decide the export" from "fetch a file" is what makes the JSON, the caps
 * document and the workbook three views of one recorded act rather than three
 * chances to export slightly different sets.
 *
 * Roles: owner and admin only, through the shared `exportBatches` capability,
 * mirroring the apply-ledger RLS policy. The route check is the first fence and
 * RLS remains the second.
 */
import {
  exportAcceptedRecommendationsForActor,
  RecommendationReviewError,
  getRecommendationRun,
} from '@wizard-ads/db';
import { authenticatedMutation, mutationBody, mutationUuid, MutationInputError } from '../../../../src/server/authenticated-mutation';
import { batchTag, exportFilenames } from '../../../../src/recommendations/export';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  return authenticatedMutation(request, async (database) => {
    const actor = database.actor;

    const body = (await mutationBody(request)) as {
      runId?: unknown;
      profileId?: unknown;
      optGroup?: unknown;
      lever?: unknown;
      note?: unknown;
      client?: unknown;
      today?: unknown;
      ids?: unknown;
    };
    if (typeof body.runId !== 'string') throw new MutationInputError('runId is required');
    if (typeof body.profileId !== 'string') throw new MutationInputError('profileId is required');
    if (typeof body.note !== 'string' || body.note.trim().length === 0) {
      throw new MutationInputError('note is required: it is the note the staged apply carries');
    }
    const optGroup = typeof body.optGroup === 'string' && body.optGroup.trim() ? body.optGroup.trim() : 'ungrouped';
    const lever = typeof body.lever === 'string' && body.lever.trim() ? body.lever.trim() : 'bid-down';
    mutationUuid(body.runId, 'runId'); mutationUuid(body.profileId, 'profileId');
    if (body.ids !== undefined && body.ids !== null && (!Array.isArray(body.ids) || body.ids.length === 0)) {
      throw new MutationInputError('ids must be a non-empty explicit selection');
    }
    const ids = Array.isArray(body.ids) ? body.ids.map((id) => mutationUuid(id, 'proposal id')) : null;

    const run = await getRecommendationRun(database, { orgId: actor.orgId, runId: body.runId });
    if (run === null) throw new MutationInputError('Not found', 404);
    if (run.profileId !== body.profileId) throw new MutationInputError('Not found', 404);

    const today =
      typeof body.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.today)
        ? body.today
        : new Date().toISOString().slice(0, 10);
    const client = typeof body.client === 'string' && body.client.trim() ? body.client : body.profileId;
    const tag = batchTag({ client, date: today, optGroup, lever });

    const result = await exportAcceptedRecommendationsForActor(database, {
      profileId: body.profileId,
      runId: body.runId,
      ids,
      tag,
      optGroup,
      lever,
      note: body.note,
    });

    return Response.json(
      {
        ...result,
        files: exportFilenames(result.tag),
        downloads: {
          rows: `/api/recommendations/export/${result.batchId}?format=rows`,
          caps: `/api/recommendations/export/${result.batchId}?format=caps`,
          workbook: `/api/recommendations/export/${result.batchId}?format=xlsx`,
        },
      },
      { status: 201 },
    );
  }, (error) => error instanceof RecommendationReviewError
    ? Response.json({ error: error.message }, { status: 400 }) : null);
}
