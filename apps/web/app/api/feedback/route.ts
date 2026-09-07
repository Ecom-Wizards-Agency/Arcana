/**
 * The tracker's list and the submit form's write.
 *
 * Both go through the same actor boundary the tag routes use: the request
 * resolves to one user in one org, and every query names that org. The role is
 * read here too, so the client can hide the triage controls — the hiding is
 * decoration, and `[itemId]/route.ts` is the enforcement.
 */
import {
  FEEDBACK_STATUSES,
  FEEDBACK_TYPES,
  countFeedback,
  listFeedbackItems,
} from '@wizard-ads/db';
import type { FeedbackStatus, FeedbackType } from '@wizard-ads/db';
import { requireOrgRole } from '../../../src/server/org-role';
import { feedbackMutationResponse, feedbackSubmission } from '../../../src/feedback/mutation-http';
import { mutationBody } from '../../../src/server/authenticated-mutation';
import { toUiItem } from '../../../src/feedback/ui';
import { can } from '../../../src/auth/roles';
import { authenticatedRead } from '../../../src/server/authenticated-read';

export const runtime = 'nodejs';

const asType = (value: string | null): FeedbackType | null =>
  value !== null && (FEEDBACK_TYPES as readonly string[]).includes(value)
    ? (value as FeedbackType)
    : null;

const asStatus = (value: string | null): FeedbackStatus | null =>
  value !== null && (FEEDBACK_STATUSES as readonly string[]).includes(value)
    ? (value as FeedbackStatus)
    : null;

export async function GET(request: Request): Promise<Response> {
  return authenticatedRead(request, async (database, actor) => {
    const role = await requireOrgRole(database, actor);
    const query = new URL(request.url).searchParams;
    const [items, counts] = await Promise.all([
      listFeedbackItems(database, {
        orgId: actor.orgId,
        viewerId: actor.userId,
        type: asType(query.get('type')),
        status: asStatus(query.get('status')),
        sort: query.get('sort') === 'votes' ? 'votes' : 'newest',
      }),
      countFeedback(database, actor.orgId),
    ]);
    return Response.json({
      // The same flattening the server-rendered first load uses, so the list
      // does not change shape the first time a filter is touched.
      items: items.map((item) => toUiItem(item, actor.userId)),
      counts,
      role,
      canTriage: can(role, 'triageFeedback'),
    });
  });
}

export async function POST(request: Request): Promise<Response> {
  return feedbackMutationResponse(request, async () => feedbackSubmission(await mutationBody(request)));
}
