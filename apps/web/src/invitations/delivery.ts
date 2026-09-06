import { teamInvitationDeliveryContext } from '@wizard-ads/db';
import type { DbHandle } from '@wizard-ads/db';
import type { InvitationDeliveryStatus, OrgActor } from '@wizard-ads/shared';
import { supabaseAdminClient, supabaseAdminConfigured } from '../auth/admin';
import { authOrigin } from '../auth/origin';
import { invitationPath, invitationTokenHash } from './recipient';

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
  }
}
