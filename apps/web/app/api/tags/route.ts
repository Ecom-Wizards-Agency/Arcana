import { createTag, listTagTree } from '@wizard-ads/db';
import { parseTagColor } from './color-input';
import { authenticatedRead } from '../../../src/server/authenticated-read';
import { authenticatedMutation, mutationBody, MutationInputError, mutationUuid } from '../../../src/server/authenticated-mutation';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  return authenticatedRead(request, async (handle, actor) =>
    Response.json({ tags: await listTagTree(handle, actor.orgId) }));
}

export async function POST(request: Request): Promise<Response> {
  return authenticatedMutation(request, async (context) => {
    const actor = context.actor;
    const body = await mutationBody(request);
    if (typeof body['name'] !== 'string') throw new MutationInputError('name is required');
    const parentId = body['parentId'] == null ? null : mutationUuid(body['parentId'], 'parentId');
    const color = parseTagColor(body['color']);
    const tag = await createTag(context, {
      orgId: actor.orgId,
      createdBy: actor.userId,
      name: body['name'],
      parentId,
      color,
    });
    return Response.json({ tag }, { status: 201 });
  });
}
