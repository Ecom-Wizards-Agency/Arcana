/**
 * The send section's server actions (WP-338g), behind the thin 'use server'
 * module in app/creators/samples/[id]/preflight/actions.ts.
 *
 * The seal action accepts only the strict shared CreatorMcfSealRequest
 * ({binding, envelope}); any other key, including any plaintext address field,
 * is refused before a database handle is opened. Nothing here logs an input or
 * an error: a refusal is a fixed code, and an unexpected failure is reported as
 * `unavailable` without its message.
 *
 * Identity comes from the request (session, or the E2E bridge in tests), never
 * from the body. Every ledger function locks and rechecks owner or admin
 * membership itself.
 *
 * The commands run on the process-owned handle, as other server actions do
 * (gateAction). The one-connection request client does not rewrite jsonb
 * serializers, and the ledger's seal wrapper binds its body as `::jsonb`, which
 * that client double-encodes (the repo's convention elsewhere is `::text::jsonb`).
 */
import { headers } from 'next/headers';
import {
  AgencyAccessDenied, approveCreatorMcfSend, refreshCreatorMcfPreview, releaseCreatorMcfSend, requestCreatorMcfSettleRead,
  resolveCreatorMcfConflict, sealCreatorMcfRecipient, withdrawCreatorMcfSend, type CreatorMcfCommandResult, type CreatorMcfRefusal,
} from '@wizard-ads/db';
import { CreatorMcfSealRequest, CreatorMcfSendApproval, type CreatorMcfSendState, type OrgActor } from '@wizard-ads/shared';
import { requireDatabase } from '../../data/db';
import { requestActor } from '../../server/request-context';

export type SendActionFailure = CreatorMcfRefusal | 'forbidden' | 'unavailable' | 'invalid';
export type SendActionResult =
  | { ok: true; sendId: string; state: CreatorMcfSendState; custodyExpiresAt?: string; claimDeadline?: string }
  | { ok: false; reason: SendActionFailure };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uuid = (value: unknown): string | null => typeof value === 'string' && UUID.test(value) ? value : null;

type Handle = ReturnType<typeof requireDatabase>;
type Command = CreatorMcfCommandResult<string> & { custodyExpiresAt?: string; claimDeadline?: string };

/** One ledger command for the requesting actor. Each command opens its own authenticated transaction. */
async function ledger(run: (handle: Handle, actor: OrgActor) => Promise<Command>): Promise<SendActionResult> {
  let actor: OrgActor;
  try {
    actor = await requestActor(await headers());
  } catch {
    return { ok: false, reason: 'forbidden' };
  }
  let handle: Handle;
  try {
    handle = requireDatabase();
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  try {
    const result = await run(handle, actor);
    if ('reason' in result) return { ok: false, reason: result.reason };
    return {
      ok: true, sendId: result.sendId, state: result.state,
      ...(result.custodyExpiresAt === undefined ? {} : { custodyExpiresAt: result.custodyExpiresAt }),
      ...(result.claimDeadline === undefined ? {} : { claimDeadline: result.claimDeadline }),
    };
  } catch (error) {
    return { ok: false, reason: error instanceof AgencyAccessDenied ? 'forbidden' : 'unavailable' };
  }
}

/**
 * "Seal address": stores the browser's envelope for the lane its binding
 * names. The strict parse refuses any body that is not exactly
 * {binding, envelope}; the SQL function then compares the binding with the
 * lane and the actor's organisation before it stores anything.
 */
export async function sealAction(body: unknown): Promise<SendActionResult> {
  const parsed = CreatorMcfSealRequest.safeParse(body);
  if (!parsed.success) return { ok: false, reason: 'envelope_invalid' };
  const request = parsed.data;
  return ledger((handle, actor) => sealCreatorMcfRecipient(handle, actor,
    { creatorRecordId: request.binding.creatorRecordId, asin: request.binding.asin, request }));
}

/** The press on "Send N unit(s) via Amazon". The database recomputes the wording and refuses any mismatch. */
export async function approveAction(approval: unknown): Promise<SendActionResult> {
  const parsed = CreatorMcfSendApproval.safeParse(approval);
  if (!parsed.success) return { ok: false, reason: 'approval_invalid' };
  return ledger((handle, actor) => approveCreatorMcfSend(handle, actor, parsed.data));
}

function bySend(command: (handle: Handle, actor: OrgActor, sendId: string) => Promise<Command>) {
  return async (sendId: unknown): Promise<SendActionResult> => {
    const id = uuid(sendId);
    if (id === null) return { ok: false, reason: 'invalid' };
    return ledger((handle, actor) => command(handle, actor, id));
  };
}

export const withdrawAction = bySend(withdrawCreatorMcfSend);
export const refreshAction = bySend(refreshCreatorMcfPreview);
export const settleReadAction = bySend(requestCreatorMcfSettleRead);
export const releaseAction = bySend(releaseCreatorMcfSend);

/** "Record as sent" on a conflict; idempotent on the request id. */
export async function resolveConflictAction(sendId: unknown, requestId: unknown): Promise<SendActionResult> {
  const id = uuid(sendId);
  const request = uuid(requestId);
  if (id === null || request === null) return { ok: false, reason: 'invalid' };
  return ledger((handle, actor) => resolveCreatorMcfConflict(handle, actor, id, request));
}
