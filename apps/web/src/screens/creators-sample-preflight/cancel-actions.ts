'use server';

/**
 * Server actions for the guarded Amazon cancel (WP-338i). Each one only
 * forwards to the checked implementation in ./send-actions.ts, which refuses a
 * bad send id or a press that is not exactly "Cancel 1 order in Amazon" before
 * any database call. The page passes the send section's other actions; the
 * section supplies these itself when the page did not.
 */
import { approveCancelAction, requestCancelPreviewAction, type SendActionResult } from './send-actions';

export async function requestMcfCancelPreview(sendId: unknown): Promise<SendActionResult> { return requestCancelPreviewAction(sendId); }
export async function approveMcfCancel(approval: unknown): Promise<SendActionResult> { return approveCancelAction(approval); }
