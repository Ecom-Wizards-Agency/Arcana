import {
  readOptimizationWorkspace,
  saveOptimizationGroupForActor,
  profileBelongsToOrg,
} from '@wizard-ads/db';
import { ScheduledOptimizationGroup } from '@wizard-ads/shared';
import { ApiReadError, authenticatedRead, readUuid } from '../../../../src/server/authenticated-read';
import { MutationInputError, mutationBody, mutationUuid } from '../../../../src/server/authenticated-mutation';
import { optimizerMutation } from '../../../../src/optimizer/mutation-http';

export const runtime = 'nodejs';
const settingsSchema = ScheduledOptimizationGroup.omit({ id: true, orgId: true, profileId: true, version: true });

export async function GET(request: Request): Promise<Response> {
  return authenticatedRead(request, async (database, actor) => {
    const profileId = new URL(request.url).searchParams.get('profileId');
    if (!profileId) throw new ApiReadError('profileId is required');
    readUuid(profileId, 'profileId');
    if (!(await profileBelongsToOrg(database, { orgId: actor.orgId, profileId }))) {
      return Response.json({ error: 'Profile not found' }, { status: 404 });
    }
    return Response.json(await readOptimizationWorkspace(database, {
      orgId: actor.orgId,
      profileId,
    }));
  });
}

export async function POST(request: Request): Promise<Response> {
  return optimizerMutation(request, async (database, actor) => {
    const body = await mutationBody(request);
    const profileId = mutationUuid(body['profileId'], 'profileId');
    const parsedSettings = settingsSchema.safeParse({
      name: requiredString(body['name'], 'name'),
      role: body['role'],
      targetAcos: fraction(body['targetAcosPercent'], 'targetAcosPercent'),
      bidFloor: optionalNonnegative(body['bidFloor'], 'bidFloor'),
      bidCeiling: optionalNonnegative(body['bidCeiling'], 'bidCeiling'),
      bidIncreaseCap: fraction(body['bidIncreaseCapPercent'], 'bidIncreaseCapPercent'),
      bidDecreaseCap: fraction(body['bidDecreaseCapPercent'], 'bidDecreaseCapPercent'),
      placementIncreaseCap: fraction(
        body['placementIncreaseCapPercent'],
        'placementIncreaseCapPercent',
      ),
      placementDecreaseCap: fraction(
        body['placementDecreaseCapPercent'],
        'placementDecreaseCapPercent',
      ),
      exclusions: stringArray(body['exclusions'], 'exclusions'),
      reviewSchedule: {
        version: 2,
        weekdays: body['reviewWeekdays'],
      },
      prioritization: body['prioritization'],
      enabled: body['enabled'] === undefined ? true : body['enabled'],
    });
    if (!parsedSettings.success) throw new MutationInputError('Invalid optimization settings');
    const settings = parsedSettings.data;
    if (
      settings.bidFloor !== null &&
      settings.bidCeiling !== null &&
      settings.bidFloor > settings.bidCeiling
    ) {
      throw new MutationInputError('bid floor cannot exceed bid ceiling');
    }
    const result = await saveOptimizationGroupForActor(database, actor, {
      profileId,
      ...(body['id'] === undefined ? {} : { id: mutationUuid(body['id'], 'id') }),
      settings,
      campaignIds: stringArray(body['campaignIds'], 'campaignIds'),
    });
    return Response.json(result, { status: 200 });
  });
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new MutationInputError(`${field} is required`);
  }
  return value.trim();
}

function finiteNumber(value: unknown, field: string): number {
  if ((typeof value !== 'string' && typeof value !== 'number') || (typeof value === 'string' && value.trim() === '')) {
    throw new MutationInputError(`${field} must be a number`);
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new MutationInputError(`${field} must be a number`);
  return parsed;
}

function fraction(value: unknown, field: string): number {
  const percent = finiteNumber(value, field);
  if (percent < 0) throw new MutationInputError(`${field} must be nonnegative`);
  return percent / 100;
}

function optionalNonnegative(value: unknown, field: string): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = finiteNumber(value, field);
  if (parsed < 0) throw new MutationInputError(`${field} must be nonnegative`);
  return parsed;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new MutationInputError(`${field} must be a string array`);
  }
  if (field === 'campaignIds' && value.some((entry: string) => entry.length === 0 || entry !== entry.trim())) {
    throw new MutationInputError('campaignIds must contain nonempty canonical strings');
  }
  return value.map((entry) => entry.trim()).filter(Boolean);
}
