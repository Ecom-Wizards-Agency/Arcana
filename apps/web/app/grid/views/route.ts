import { listGridViews, saveGridViews, removeGridView } from '@wizard-ads/db';
import { GridEntity, GridViewSave } from '@wizard-ads/shared';
import { authenticatedRead, ApiReadError, readUuid } from '../../../src/server/authenticated-read';
import { authenticatedMutation, mutationBody, MutationInputError } from '../../../src/server/authenticated-mutation';

export const runtime = 'nodejs';
export async function GET(request: Request): Promise<Response> {
  return authenticatedRead(request, async (snapshot) => {
    const query = new URL(request.url).searchParams;
    const entity = GridEntity.safeParse(query.get('entity'));
    if (!entity.success) throw new ApiReadError('Invalid entity');
    const profile = query.get('profile');
    const views = await listGridViews(snapshot, entity.data, profile === null ? null : readUuid(profile, 'profile'));
    return Response.json({ views, count: views.length });
  });
}
export async function POST(request: Request): Promise<Response> {
  return authenticatedMutation(request, async (context) => {
    const input = GridViewSave.safeParse(await mutationBody(request));
    if (!input.success) throw new MutationInputError('Invalid saved views');
    return Response.json({ count: await saveGridViews(context, input.data) });
  });
}
export async function DELETE(request: Request): Promise<Response> {
  return authenticatedMutation(request, async (context) => {
    const body = await mutationBody(request);
    if (typeof body['id'] !== 'string') throw new MutationInputError('View ID required');
    return Response.json({ count: await removeGridView(context, body['id']) });
  });
}
