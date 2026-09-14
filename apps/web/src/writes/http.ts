import { AgencyAccessDenied, type AuthenticatedEditorTransaction, type AuthenticatedReadSnapshot } from '@wizard-ads/db';
import { resolveMethod } from '@wizard-ads/core';
import { MethodSelection } from '@wizard-ads/shared';
import { SpWriteConfirmedApprovalRequest } from '@wizard-ads/shared/sp-write-application';
import { SpWriteSourceEvidence } from '@wizard-ads/shared/sp-write-preview-evidence';
import { SpWriteApplicationError } from '@wizard-ads/db/sp-write-application';
import { authenticatedMutation } from '../server/authenticated-mutation';
import { authenticatedRead } from '../server/authenticated-read';
import { JsonMutationError, readJsonMutation } from '../server/json-mutation';
import { requireCapability } from '../server/org-role';
import { RequestAuthError } from '../server/request-context';

type InputSchema<T> = { safeParse(input: unknown): { success: true; data: T } | { success: false } };

/** Errors leave the transaction before mapping, so failed readback rolls back DML. */
export function spWriteHttpFailure(error: unknown): Response | null {
  if (error instanceof RequestAuthError || error instanceof AgencyAccessDenied) return null;
  if (error instanceof JsonMutationError) return Response.json({ code: error.code }, { status: error.status });
  const sqlCode = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
  const code = error instanceof SpWriteApplicationError ? error.code
    : sqlCode === '42501' ? 'authorization_refused'
    : sqlCode === '23505' ? 'identity_conflict'
    : sqlCode === '55000' || sqlCode === 'P0002' ? 'source_changed'
    : sqlCode === '22023' || sqlCode === '22P02' ? 'invalid_request' : 'outcome_unknown';
  const status = { not_found: 404, invalid_request: 400, unsupported_source: 422,
    source_changed: 409, identity_conflict: 409, authorization_refused: 403, outcome_unknown: 503 }[code];
  return Response.json({ code }, { status });
}

export function handleSpWriteMutation<T>(request: Request, schema: InputSchema<T>,
  command: (context: AuthenticatedEditorTransaction, input: T) => Promise<unknown>) {
  return authenticatedMutation(request, async (context) => {
    await requireCapability(context, 'exportBatches');
    const parsed = schema.safeParse(await readJsonMutation(request));
    if (!parsed.success) throw new JsonMutationError(400, 'invalid_request');
    const approval = SpWriteConfirmedApprovalRequest.safeParse(parsed.data);
    if (approval.success) {
      const rows = await context.sql<{ artifact_text: string }[]>`
        select artifact_text from public.sp_write_preview_evidence
         where org_id = ${context.actor.orgId}::uuid and profile_id = ${approval.data.profileId}::uuid
           and plan_id = ${approval.data.approval.plan.planId}::uuid
      `;
      for (const row of rows) {
        const evidence = SpWriteSourceEvidence.parse(JSON.parse(row.artifact_text));
        if (evidence.schemaVersion === 'openspell.sp-write-preview-evidence.v2') continue;
        for (const source of evidence.provenance.rows) {
          if (source.method !== undefined) assertExecutableMethod(source.method.methodId, source.method.methodVersion);
        }
      }
    }
    return Response.json(await command(context, parsed.data));
  }, spWriteHttpFailure);
}

export function handleSpWriteRead<T>(request: Request, schema: InputSchema<T>,
  read: (context: AuthenticatedReadSnapshot, input: T) => Promise<unknown>) {
  return authenticatedRead(request, async (context) => {
    await requireCapability(context, 'exportBatches');
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].length !== new Set(params.keys()).size) throw new JsonMutationError(400, 'invalid_request');
    const parsed = schema.safeParse(Object.fromEntries(params));
    if (!parsed.success) throw new JsonMutationError(400, 'invalid_request');
    return Response.json(await read(context, parsed.data));
  }, spWriteHttpFailure);
}

/** Resolve release state from the installed catalogue, never from submitted metadata. */
export function assertExecutableMethod(id: string, version: string): void {
  const selection = MethodSelection.safeParse({ id, version });
  if (!selection.success) throw new JsonMutationError(422, 'method_not_executable');
  let release: string;
  try { release = resolveMethod(selection.data.id, selection.data.version).descriptor.releaseState; }
  catch { throw new JsonMutationError(422, 'method_not_executable'); }
  if (release !== 'pilot' && release !== 'stable') throw new JsonMutationError(422, 'method_not_executable');
}
