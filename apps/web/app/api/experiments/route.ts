/**
 * The experiment list and the create write.
 *
 * Reading is every member's right, so the GET checks membership and nothing
 * more. Creating needs `manageExperiments` (analyst or better), and the created
 * row is stamped with the actor as its author so the "edit your own" rule the
 * database enforces has something to match.
 */
import { EXPERIMENT_STATUSES, listExperiments, profileBelongsToOrg, mutateExperimentForActor } from '@wizard-ads/db';
import type { ExperimentStatus } from '@wizard-ads/shared';
import { requireOrgRole } from '../../../src/server/org-role';
import { authenticatedMutation, mutationBody } from '../../../src/server/authenticated-mutation';
import { experimentCommand, experimentErrorResponse, experimentMutationResponse } from '../../../src/experiments/http';
import { listProposedTests } from '../../../src/experiments/data';
import { can } from '../../../src/auth/roles';
import { authenticatedRead, readUuid } from '../../../src/server/authenticated-read';

export const runtime = 'nodejs';

const asStatus = (value: string | null): ExperimentStatus | null =>
  value !== null && (EXPERIMENT_STATUSES as readonly string[]).includes(value)
    ? (value as ExperimentStatus)
    : null;

export async function GET(request: Request): Promise<Response> {
  return authenticatedRead(request, async (database, actor) => {
    const role = await requireOrgRole(database);
    const query = new URL(request.url).searchParams;
    const profileId = query.get('profile');
    if (profileId !== null) {
      readUuid(profileId, 'profile');
      if (!(await profileBelongsToOrg(database, { orgId: actor.orgId, profileId }))) {
        return Response.json({ error: 'Profile not found' }, { status: 404 });
      }
    }
    const [items, proposedTests] = await Promise.all([
      listExperiments(database, {
        orgId: actor.orgId,
        profileId,
        status: asStatus(query.get('status')),
      }),
      profileId === null
        ? Promise.resolve([])
        : listProposedTests(database, { orgId: actor.orgId, profileId }),
    ]);
    return Response.json({
      items,
      proposedTests,
      role,
      canManage: can(role, 'manageExperiments'),
    });
  });
}

export async function POST(request: Request): Promise<Response> {
  return authenticatedMutation(request, async (context) => {
    const command = experimentCommand(await mutationBody(request));
    return experimentMutationResponse(await mutateExperimentForActor(context, context.actor, command));
  }, experimentErrorResponse);
}
