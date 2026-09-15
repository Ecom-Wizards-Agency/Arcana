import { bulkAssignTagByFilter, bulkUnassignTagByFilter } from '@wizard-ads/db';
import type { TagEntityFilter, TaggableEntityType } from '@wizard-ads/db';
import { authenticatedMutation, mutationBody, MutationInputError, mutationUuid } from '../../../../../src/server/authenticated-mutation';

export const runtime = 'nodejs';
type RouteContext = { params: Promise<{ tagId: string }> };

const TAGGABLE_TYPES = new Set<string>([
  'profile', 'portfolio', 'campaign', 'ad_group', 'product_ad', 'keyword', 'target', 'negative',
]);
const ENTITY_STATES = new Set<string>(['enabled', 'paused', 'archived']);

function stringList(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) {
    throw new MutationInputError(`${field} must be a list of text values`);
  }
  return value;
}

/** Invalid supplied filters must never be omitted into an unrestricted write. */
function parseFilter(raw: unknown): TagEntityFilter {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new MutationInputError('A valid filter is required');
  const filter = raw as Record<string, unknown>;
  if (typeof filter['entityType'] !== 'string' || !TAGGABLE_TYPES.has(filter['entityType'])) {
    throw new MutationInputError('A valid filter.entityType is required');
  }
  const profileIds = stringList(filter['profileIds'], 'profileIds')?.map((id) => mutationUuid(id, 'profileId'));
  const entityIds = stringList(filter['entityIds'], 'entityIds');
  if (filter['entityType'] === 'profile') entityIds?.forEach((id) => mutationUuid(id, 'entityId'));
  const states = stringList(filter['states'], 'states');
  if (states?.some((state) => !ENTITY_STATES.has(state))) throw new MutationInputError('Filter contains an invalid entity state');
  if (filter['search'] !== undefined && typeof filter['search'] !== 'string') throw new MutationInputError('search must be text');
  return {
    entityType: filter['entityType'] as TaggableEntityType,
    ...(profileIds === undefined ? {} : { profileIds }),
    ...(entityIds === undefined ? {} : { entityIds }),
    ...(states === undefined ? {} : { states: states as TagEntityFilter['states'] }),
    ...(typeof filter['search'] === 'string' ? { search: filter['search'] } : {}),
  };
}

export async function POST(request: Request, route: RouteContext): Promise<Response> {
  return authenticatedMutation(request, async (context) => {
    const tagId = mutationUuid((await route.params).tagId, 'tagId');
    const body = await mutationBody(request);
    const result = await bulkAssignTagByFilter(context, {
      orgId: context.actor.orgId, tagId, filter: parseFilter(body['filter']), createdBy: context.actor.userId,
    });
    return Response.json({ result });
  });
}

/** The inverse of POST: drop this tag from everything the filter matches. */
export async function DELETE(request: Request, route: RouteContext): Promise<Response> {
  return authenticatedMutation(request, async (context) => {
    const tagId = mutationUuid((await route.params).tagId, 'tagId');
    const body = await mutationBody(request);
    const result = await bulkUnassignTagByFilter(context, {
      orgId: context.actor.orgId, tagId, filter: parseFilter(body['filter']),
    });
    return Response.json({ result });
  });
}
