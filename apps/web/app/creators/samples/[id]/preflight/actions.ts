'use server';

/**
 * Server actions for the sample send section. Each one only forwards to the
 * checked implementation in src/screens/creators-sample-preflight/send-actions.ts,
 * which accepts the strict envelope and never logs a body.
 */
import {
  approveAction, refreshAction, releaseAction, resolveConflictAction, sealAction, settleReadAction, withdrawAction,
  type SendActionResult,
} from '../../../../../src/screens/creators-sample-preflight/send-actions';

export async function sealMcfRecipient(body: unknown): Promise<SendActionResult> { return sealAction(body); }
export async function approveMcfSend(approval: unknown): Promise<SendActionResult> { return approveAction(approval); }
export async function withdrawMcfSend(sendId: unknown): Promise<SendActionResult> { return withdrawAction(sendId); }
export async function refreshMcfPreview(sendId: unknown): Promise<SendActionResult> { return refreshAction(sendId); }
export async function requestMcfSettleRead(sendId: unknown): Promise<SendActionResult> { return settleReadAction(sendId); }
export async function releaseMcfSend(sendId: unknown): Promise<SendActionResult> { return releaseAction(sendId); }
export async function resolveMcfConflict(sendId: unknown, requestId: unknown): Promise<SendActionResult> {
  return resolveConflictAction(sendId, requestId);
}
