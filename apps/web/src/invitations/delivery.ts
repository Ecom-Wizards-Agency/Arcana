import { issueTeamInvitationLinkForActor, teamInvitationDeliveryContext } from '@wizard-ads/db';
import type { DbHandle } from '@wizard-ads/db';
import type { InvitationDeliveryStatus, OrgActor } from '@wizard-ads/shared';
import { generateAuthLink, supabaseAdminClient, supabaseAdminConfigured } from '../auth/admin';
import { authOrigin } from '../auth/origin';
import { invitationPath, invitationTokenHash } from './recipient';

export interface TeamInvitationLink {
  status: InvitationDeliveryStatus;
  /** Shown once to the inviting manager. Never persisted, logged or put in a redirect. */
  url: string;
}

/**
 * Link delivery, the default. A new account gets the invitation path with a
 * one-time Auth token hash, the same link the invite email carries; the
 * landing page still verifies it by explicit POST. An existing account gets
 * the plain invitation path. No email is sent. Each returned link is audited.
 */
export async function createTeamInvitationLink(
  handle: Pick<DbHandle, 'sql'>, actor: OrgActor, token: string,
): Promise<TeamInvitationLink> {
  const hash = invitationTokenHash(token);
  if (!hash) throw new Error('Invalid invitation token.');
  const invitationUrl = new URL(invitationPath('team', token), authOrigin());
  const link = await issueTeamInvitationLinkForActor(handle, actor, hash, async (email) => {
    if (!supabaseAdminConfigured()) return { status: 'unavailable', url: invitationUrl.toString() };
    const generated = await generateAuthLink('invite', email, invitationUrl.toString());
    if (generated.status !== 'ok') return { status: generated.status, url: invitationUrl.toString() };
    const activation = new URL(invitationUrl);
    activation.searchParams.set('token_hash', generated.tokenHash);
    return { status: 'link_ready', url: activation.toString() };
  });
  return { status: link.status, url: link.url };
}

/** Only a current manager and the saved open recipient can admit one send. */
export async function deliverTeamInvitation(
  handle: Pick<DbHandle, 'sql'>, actor: OrgActor, token: string,
): Promise<InvitationDeliveryStatus> {
  if (!supabaseAdminConfigured()) return 'unavailable';
  const hash = invitationTokenHash(token);
  if (!hash) return 'failed';
  let context: Awaited<ReturnType<typeof teamInvitationDeliveryContext>>;
  let redirectTo: string;
  try {
    context = await teamInvitationDeliveryContext(handle, actor, hash);
    redirectTo = new URL(invitationPath('team', token), authOrigin()).toString();
  } catch {
    return 'failed';
  }
  try {
    const result = await supabaseAdminClient().auth.admin.inviteUserByEmail(context.email, { redirectTo });
    if (result.error?.code === 'email_exists' || result.error?.code === 'user_already_exists') return 'existing_account';
    if (result.error) return !result.error.status || result.error.status >= 500 ? 'uncertain' : 'failed';
    return result.data.user?.email?.trim().toLowerCase() === context.email.toLowerCase()
      ? 'accepted_by_provider' : 'uncertain';
  } catch {
    // A request may have been accepted before its response was lost. Never
    // resend here or include provider errors, which can contain credentials.
    return 'uncertain';
  }
}

export function teamInvitationDeliveryMessage(status: InvitationDeliveryStatus): string {
  switch (status) {
    case 'accepted_by_provider': return 'The email invitation was accepted for delivery. The recipient will verify their email and set a password.';
    case 'existing_account': return 'This account already exists. Share the invitation link so the recipient can sign in and accept.';
    case 'unavailable': return 'Email invitations are not configured. Existing users can accept the link; an installation operator must arrange activation for new users.';
    case 'failed': return 'The invitation is saved, but email delivery was refused. Share the link with an existing user or ask an installation operator to check delivery.';
    case 'uncertain': return 'The invitation is saved, but email delivery could not be confirmed. Check for the email before requesting another invitation.';
    case 'link_ready': return 'The invitation link is ready. No email was sent.';
  }
}

/** Short delivery status beside a link shown once. */
export function invitationLinkStatusLabel(status: InvitationDeliveryStatus): string {
  switch (status) {
    case 'link_ready':
    case 'existing_account': return 'Link ready';
    case 'unavailable': return 'Link ready for existing accounts';
    case 'failed':
    case 'uncertain': return 'Account link not created';
    case 'accepted_by_provider': return 'Email accepted for delivery';
  }
}

/** What the manager does with a link shown once. */
export function invitationLinkInstruction(status: InvitationDeliveryStatus, email: string): string {
  switch (status) {
    case 'link_ready':
    case 'accepted_by_provider':
      return `Send this link to ${email} yourself; it opens the invitation and lets them set a password. It is shown only now.`;
    case 'existing_account':
      return `Send this link to ${email} yourself; they already have an account, so they sign in and accept. It is shown only now.`;
    case 'unavailable':
      return `Send this link to ${email} yourself. It works only if they already have an account, because account links are not configured here. It is shown only now.`;
    case 'failed':
    case 'uncertain':
      return `Send this link to ${email} yourself only if they already have an account. A new-account link could not be created; revoke this invitation and invite again. It is shown only now.`;
  }
}
