import { deleteTagInTransaction, updateTag } from '@wizard-ads/db';
import type { DeleteTagMode } from '@wizard-ads/db';
import { parseTagColorPatch } from '../color-input';
import { authenticatedMutation, mutationBody, MutationInputError, mutationUuid } from '../../../../src/server/authenticated-mutation';

export const runtime = 'nodejs';
type RouteContext = { params: Promise<{ tagId: string }> };

export async function PATCH(request: Request, route: RouteContext): Promise<Response> {
  return authenticatedMutation(request, async (context) => {
    const tagId = mutationUuid((await route.params).tagId, 'tagId');
    const body = await mutationBody(request);
    if (body['name'] !== undefined && typeof body['name'] !== 'string') throw new MutationInputError('name must be text');
    const tag = await updateTag(context, {
      orgId: context.actor.orgId,
      tagId,
      ...(typeof body['name'] === 'string' ? { name: body['name'] } : {}),
      ...(body['parentId'] === undefined ? {} : { parentId: body['parentId'] === null ? null : mutationUuid(body['parentId'], 'parentId') }),
      ...parseTagColorPatch(body['color']),
    });
    return Response.json({ tag });
  });
}

export async function DELETE(request: Request, route: RouteContext): Promise<Response> {
  return authenticatedMutation(request, async (context) => {
    const tagId = mutationUuid((await route.params).tagId, 'tagId');
    const body = await mutationBody(request);
    let disposition: DeleteTagMode;
    if (body['mode'] === 'detach') disposition = { mode: 'detach' };
    else if (body['mode'] === 'reassign') {
      disposition = { mode: 'reassign', targetTagId: mutationUuid(body['targetTagId'], 'targetTagId') };
    } else {
      throw new MutationInputError('Delete requires detach or a reassignment target');
    }
    return Response.json({ result: await deleteTagInTransaction(context, { tagId, disposition }) });
  });
}
