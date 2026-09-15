/**
 * Deterministic duplicate hints for the bug widget.
 *
 * This route does no semantic work. It resolves one member in one organisation
 * and delegates the bounded, open-bug-only title match to the database layer.
 */
import { findSimilarOpenBugs } from '@wizard-ads/db';
import { toUiItem } from '../../../../src/feedback/ui';
import { authenticatedRead } from '../../../../src/server/authenticated-read';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  return authenticatedRead(request, async (database, actor) => {
    const query = new URL(request.url).searchParams.get('q') ?? '';
    const items = await findSimilarOpenBugs(database, {
      orgId: actor.orgId,
      viewerId: actor.userId,
      query,
    });
    return Response.json({ items: items.map((item) => toUiItem(item, actor.userId)) });
  });
}
