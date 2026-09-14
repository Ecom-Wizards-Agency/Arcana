import { authenticatedRead, ApiReadError, readUuid } from '../../../../src/server/authenticated-read';
import { loadTarget360 } from '../../../../src/screens/targets/model';
export const runtime = 'nodejs';
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return authenticatedRead(request, async (handle, actor) => {
    const { id } = await context.params;
    const query = new URL(request.url).searchParams;
    const profileId = query.get('profile'); readUuid(profileId, 'profile');
    const from = query.get('from'), to = query.get('to');
    if (!profileId || !from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) throw new ApiReadError('An ordered date window and profile are required');
    const model = await loadTarget360(handle, { orgId: actor.orgId, profileId, targetId: id, from, to });
    return model === null ? Response.json({ error: 'Not found' }, { status: 404 }) : Response.json(model);
  });
}
