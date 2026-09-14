/**
 * The experiment routes' error mapping and body helpers.
 *
 * WP-08's `errorResponse` already turns an auth error into its status and a
 * "not found" into a 404. The one case it cannot know about is a status move
 * that the lifecycle forbids: that is a conflict with the resource's current
 * state, not a malformed request, so it answers 409 rather than 400.
 */
import {
  ExperimentCommandError,
  ExperimentNotFound,
  ExperimentProfileNotFound,
  InvalidExperimentTransition,
  InvalidExperimentWindow,
} from '@wizard-ads/db';
import { ExperimentCommand, ExperimentMutationResponse, Uuid, type ExperimentCommandResult } from '@wizard-ads/shared';
import { MutationInputError } from '../server/authenticated-mutation';
import { errorResponse } from '../server/request-context';

export function experimentErrorResponse(error: unknown): Response | null {
  if (error instanceof ExperimentCommandError) {
    return Response.json({ error: error.message, code: error.code }, {
      status: { invalid: 400, forbidden: 403, not_found: 404, conflict: 409, unconfirmed: 503 }[error.code],
    });
  }
  if (error instanceof InvalidExperimentTransition) {
    return Response.json({ error: error.message }, { status: 409 });
  }
  if (error instanceof ExperimentNotFound) {
    return Response.json({ error: error.message }, { status: 404 });
  }
  // A profile that is not this org's is indistinguishable from one that does
  // not exist: both are 404, so the answer cannot be used to enumerate ids.
  if (error instanceof ExperimentProfileNotFound) {
    return Response.json({ error: 'Profile not found' }, { status: 404 });
  }
  // A window that ends before it starts is a bad request, not a conflict.
  if (error instanceof InvalidExperimentWindow) {
    return Response.json({ error: error.message }, { status: 400 });
  }
  return error instanceof SyntaxError ? errorResponse(error) : null;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Parse a comma-or-array list of ids into a clean string array, or undefined. */
export function idList(value: unknown): string[] | undefined {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  const cleaned = Array.from(
    new Set(raw.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim())),
  ).filter((entry) => entry !== '');
  return cleaned.length > 0 ? cleaned : undefined;
}

/** Keep the HTTP shape compatible while the shared command rejects unknown fields. */
export function experimentCommand(body: Record<string, unknown>, experimentId?: string): ExperimentCommand {
  if (experimentId === undefined && typeof body['profileId'] === 'string' && !Uuid.safeParse(body['profileId']).success) {
    throw new MutationInputError('Profile not found', 404);
  }
  const transition = body['status'] !== undefined || body['resultNote'] !== undefined;
  const parsed = ExperimentCommand.safeParse({ ...body,
    ...(experimentId === undefined ? { kind: 'create' } : { kind: transition ? 'transition' : 'edit', experimentId }),
  });
  if (!parsed.success) throw new MutationInputError('Check the experiment fields and try again.');
  return parsed.data;
}

/** Serialize and validate before the route's transaction can commit. */
export function experimentMutationResponse(result: ExperimentCommandResult): Response {
  const body = ExperimentMutationResponse.parse(JSON.parse(JSON.stringify({ item: result.item, event: result.event })));
  return Response.json(body, { status: result.kind === 'created' ? 201 : 200 });
}
