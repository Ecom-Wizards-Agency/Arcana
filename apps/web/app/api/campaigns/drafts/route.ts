import { readCampaignDraft, CampaignDraftConflict } from '@wizard-ads/db';
import { authenticatedRead, readUuid } from '../../../../src/server/authenticated-read';
import { authenticatedMutation, mutationBody, mutationUuid, MutationInputError } from '../../../../src/server/authenticated-mutation';
import { exportBuilderDraft, saveBuilderDraft, validateSavedBuilderDraft } from '../../../../src/campaigns/drafts';
export const runtime = 'nodejs';
export async function GET(request: Request): Promise<Response> {
  return authenticatedRead(request, async (context) => {
    const query = new URL(request.url).searchParams;
    const profileId = readUuid(query.get('profileId'), 'profileId');
    const id = readUuid(query.get('id'), 'id');
    if (query.get('output') === 'xlsx') {
      const artifact = await exportBuilderDraft(context, profileId, id);
      return new Response(new Uint8Array(artifact.bytes), { headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'content-disposition': 'attachment; filename="campaign-draft.xlsx"', 'x-wizard-ads-bulk-rows': String(artifact.sheet.rows.length) } });
    }
    const draft = await readCampaignDraft(context, profileId, id);
    return draft ? Response.json(draft) : Response.json({ error: 'Draft not found' }, { status: 404 });
  });
}
export async function POST(request: Request): Promise<Response> {
  return authenticatedMutation(request, async (context) => {
    const body = await mutationBody(request);
    const profileId = mutationUuid(body['profileId'], 'profileId');
    const id = mutationUuid(body['id'], 'id');
    const revision = body['expectedRevision'];
    if (revision !== null && (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1)) throw new MutationInputError('A saved revision or null is required');
    if (body['action'] === 'validate') {
      if (revision === null) throw new MutationInputError('Save the draft before validating');
      return Response.json(await validateSavedBuilderDraft(context, profileId, id, revision));
    }
    if (body['action'] !== 'save') throw new MutationInputError('Only saving and validation are available');
    return Response.json(await saveBuilderDraft(context, { profileId, id, expectedRevision: revision, recipe: body['recipe'], validate: body['validate'] === true }));
  }, (error) => error instanceof CampaignDraftConflict ? Response.json({ error: error.message }, { status: 409 }) : null);
}
