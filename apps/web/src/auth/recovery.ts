import {
  AgencyAccessDenied, issueMemberRecoveryLinkForActor, MemberRecoveryLinkRefused, type DbHandle,
} from '@wizard-ads/db';
import { MEMBER_RECOVERY_LINK_INTERVAL_MINUTES, type OrgActor } from '@wizard-ads/shared';
import { generateAuthLink, supabaseAdminConfigured } from './admin';
import { authFeatureConfig } from './config';
import { authOrigin } from './origin';
import { safeNextPath } from './next-path';
import { supabaseConfigured, supabaseServerClient } from './supabase';

export type RecoveryRequestResult =
  | { status: 'sent' }
  | { status: 'invalid'; message: string }
  | { status: 'disabled'; message: string };

/** Send a PKCE recovery link without exposing account or provider state. */
export async function requestPasswordRecovery(emailInput: string, requestedNext?: string): Promise<RecoveryRequestResult> {
  const email = emailInput.trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return { status: 'invalid', message: 'Enter a valid email address.' };
  }
  if (!authFeatureConfig().passwordRecovery || !supabaseConfigured()) {
    return { status: 'disabled', message: 'Password recovery is not available.' };
  }

  const callback = new URL('/auth/recovery/callback', authOrigin());
  callback.searchParams.set('next', safeNextPath(requestedNext, '/dashboard'));
  try {
    const supabase = await supabaseServerClient();
    await supabase.auth.resetPasswordForEmail(email, { redirectTo: callback.toString() });
  } catch {
    // Network failures and provider exceptions are nondisclosing too.
  }

  // Provider errors and unknown accounts intentionally produce the same result.
  return { status: 'sent' };
}

export type MemberRecoveryLinkResult =
  | { status: 'ok'; url: string; email: string }
  | { status: 'error'; message: string };

export const MEMBER_RECOVERY_LINK_ERRORS = {
  unavailable: 'Reset links are not configured for this installation.',
  forbidden: 'Only admins and owners can manage members.',
  self: 'Change your own password from your account settings.',
  not_member: 'That person is no longer a member.',
  owner_only: 'Only an owner can create a reset link for another owner.',
  other_orgs: 'This member also belongs to a workspace you do not manage, so they must reset their password themselves.',
  rate_limited: `A reset link was created for this member in the last ${MEMBER_RECOVERY_LINK_INTERVAL_MINUTES} minutes. Try again later.`,
  failed: 'The reset link could not be created. Try again later.',
} as const;

/**
 * Owner/admin-issued reset link for another member. No email is sent. The
 * link opens the recovery callback, which verifies the token only after an
 * explicit POST and then asks for a new password. Audited and rate limited.
 */
export async function createMemberRecoveryLink(
  handle: Pick<DbHandle, 'sql'>, actor: OrgActor, userId: string,
): Promise<MemberRecoveryLinkResult> {
  if (!supabaseAdminConfigured()) return { status: 'error', message: MEMBER_RECOVERY_LINK_ERRORS.unavailable };
  const callback = new URL('/auth/recovery/callback', authOrigin());
  callback.searchParams.set('next', '/dashboard');
  try {
    const issued = await issueMemberRecoveryLinkForActor(handle, actor, { userId }, async (email) => {
      const generated = await generateAuthLink('recovery', email, callback.toString());
      if (generated.status !== 'ok') return null;
      const link = new URL(callback);
      link.searchParams.set('token_hash', generated.tokenHash);
      return link.toString();
    });
    return { status: 'ok', url: issued.url, email: issued.email };
  } catch (error) {
    if (error instanceof MemberRecoveryLinkRefused) return { status: 'error', message: MEMBER_RECOVERY_LINK_ERRORS[error.reason] };
    if (error instanceof AgencyAccessDenied) return { status: 'error', message: MEMBER_RECOVERY_LINK_ERRORS.forbidden };
    // Provider and driver errors can contain tokens; never surface them.
    return { status: 'error', message: MEMBER_RECOVERY_LINK_ERRORS.failed };
  }
}
