/** Profile-scoped, current entity choices for the experiment creation form. */
import { profileBelongsToOrg } from '@wizard-ads/db';
import { listExperimentScopeOptions } from '../../../../src/experiments/data';
import { requireCapability } from '../../../../src/server/org-role';
import { ApiReadError, authenticatedRead, readUuid } from '../../../../src/server/authenticated-read';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  return authenticatedRead(request, async (database, actor) => {
    await requireCapability(database, actor, 'manageExperiments');
    const profileId = new URL(request.url).searchParams.get('profile');
    if (profileId === null || profileId.trim() === '') {
      throw new ApiReadError('profile is required');
    }
    readUuid(profileId, 'profile');
    if (!(await profileBelongsToOrg(database, { orgId: actor.orgId, profileId }))) {
      return Response.json({ error: 'Profile not found' }, { status: 404 });
    }

    const options = await listExperimentScopeOptions(database, {
      orgId: actor.orgId,
      profileId,
    });
    return Response.json(options);
  });
}
