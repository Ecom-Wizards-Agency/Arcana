import { createGotoLink } from '@wizard-ads/db';
import type { JsonValue } from '@wizard-ads/db';
import { authenticatedMutation, mutationBody, MutationInputError } from '../../../src/server/authenticated-mutation';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  return authenticatedMutation(request, async (context) => {
    const body = await mutationBody(request);
    if (typeof body['route'] !== 'string') throw new MutationInputError('route is required');
    if (body['expiresAt'] !== undefined && body['expiresAt'] !== null && typeof body['expiresAt'] !== 'string') {
      throw new MutationInputError('expiresAt is invalid');
    }
    const expiresAt = typeof body['expiresAt'] === 'string' ? new Date(body['expiresAt']) : body['expiresAt'];
    if (expiresAt && Number.isNaN(expiresAt.getTime())) throw new MutationInputError('expiresAt is invalid');
    if (body['label'] !== undefined && body['label'] !== null && typeof body['label'] !== 'string') {
      throw new MutationInputError('label must be text');
    }
    const signingSecret = process.env['GOTO_LINK_SIGNING_SECRET'];
    if (!signingSecret) throw new Error('Goto signing is unavailable');
    const link = await createGotoLink(context, {
      orgId: context.actor.orgId,
      route: body['route'],
      state: (body['state'] ?? {}) as JsonValue,
      signingSecret,
      expiresAt,
      label: typeof body['label'] === 'string' ? body['label'] : null,
      createdBy: context.actor.userId,
    });
    return Response.json({ token: link.token, path: `/go/${link.token}`, expiresAt: link.expiresAt }, { status: 201 });
  });
}
