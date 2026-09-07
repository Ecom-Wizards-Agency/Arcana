import { requestActor, errorResponse, openWebDatabase, requireOrgMembership } from '../../../src/server/request-context';
import { createTag, listTagTree } from '@wizard-ads/db';
import { parseTagColor } from './color-input';
import { authenticatedRead } from '../../../src/server/authenticated-read';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  return authenticatedRead(request, async (handle, actor) =>
    Response.json({ tags: await listTagTree(handle, actor.orgId) }));
}

export async function POST(request: Request): Promise<Response> {
  const database = openWebDatabase();
  try {
    const actor = await requestActor(request.headers);
    await requireOrgMembership(database, actor);
    const body = (await request.json()) as {
      name?: unknown;
      parentId?: unknown;
      color?: unknown;
    };
    if (typeof body.name !== 'string') throw new Error('name is required');
    const parentId = body.parentId === null || typeof body.parentId === 'string' ? body.parentId : null;
    const color = parseTagColor(body.color);
    const tag = await createTag(database, {
      orgId: actor.orgId,
      createdBy: actor.userId,
      name: body.name,
      parentId,
      color,
    });
    return Response.json({ tag }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  } finally {
    await database.close();
  }
}
