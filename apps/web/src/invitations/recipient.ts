import { createHash } from 'node:crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  acceptAgencyBootstrapInvitation, acceptTeamInvitation,
  inspectAgencyBootstrapInvitation, inspectTeamInvitation,
} from '@wizard-ads/db';
import type { BootstrapInvitationState, OrgRole } from '@wizard-ads/shared';
import { authContinuePath } from '../auth/continuation';
import { authorizeSecurityChange } from '../auth/security-authorization';
import { currentUser } from '../auth/session';
import { supabaseConfigured, supabaseServerClient } from '../auth/supabase';
import { ORG_COOKIE } from '../cookies';
import { database, requireDatabase } from '../data/db';

export type InvitationKind = 'agency' | 'team';
export interface RecipientInvitation {
  agencyName: string;
  email: string;
  role: OrgRole;
  state: BootstrapInvitationState;
}

export const INVITATION_ERRORS = {
  account: 'This invitation was issued to a different address. Sign out before continuing.',
  unavailable: 'This invitation is unavailable. Ask the person who invited you for a new invitation.',
  authentication: 'Account security could not be verified. Sign in again and reopen this invitation.',
  verification: 'The email link could not be verified. Sign in if you already chose a password, or use password recovery.',
  acceptance: 'Joining could not be confirmed. Reopen this invitation to check the result. If access was removed, ask an agency owner.',
} as const;

export function invitationPath(kind: InvitationKind, token: string): string {
  return `/${kind === 'agency' ? 'agency-invite' : 'invite'}/${encodeURIComponent(token)}`;
}

export function invitationTokenHash(token: string): string | null {
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? createHash('sha256').update(token).digest('hex') : null;
}

export function validAuthInvitationToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,256}$/.test(value);
}

export async function loadRecipientInvitation(kind: InvitationKind, token: string): Promise<RecipientInvitation | null> {
  const hash = invitationTokenHash(token);
  const handle = database();
  if (!hash || !handle) return null;
  if (kind === 'agency') {
    const invitation = await inspectAgencyBootstrapInvitation(handle, hash);
    return invitation === null ? null : {
      agencyName: invitation.agencyName, email: invitation.ownerEmail, role: 'owner', state: invitation.state,
    };
  }
  return inspectTeamInvitation(handle, hash);
}

/** Membership, receipt and audit commit together under the verified identity. */
export async function acceptRecipientInvitation(kind: InvitationKind, token: string): Promise<void> {
  const path = invitationPath(kind, token);
  const invitation = await loadRecipientInvitation(kind, token);
  if (!invitation || (invitation.state !== 'pending' && invitation.state !== 'accepted')) {
    redirect(`${path}?error=unavailable`);
  }
  const user = await currentUser();
  if (!user) redirect(`/login?${new URLSearchParams({ next: path }).toString()}`);
  if (user.email?.trim().toLowerCase() !== invitation.email.toLowerCase()) redirect(`${path}?error=account`);

  // Establishing membership requires the account's strongest enrolled factor.
  // The ordinary role policy still gates workspace access after acceptance;
  // a first member can then enroll if their installation requires owner MFA.
  const authorization = await authorizeSecurityChange(path);
  if (authorization.status === 'challenge') redirect(authorization.href);
  if (authorization.status !== 'ok' || authorization.user.id !== user.id) redirect(`${path}?error=authentication`);
  let orgId: string;
  try {
    const handle = requireDatabase();
    const hash = invitationTokenHash(token)!;
    const result = kind === 'agency'
      ? await acceptAgencyBootstrapInvitation(handle, { userId: user.id }, hash)
      : await acceptTeamInvitation(handle, { userId: user.id }, hash);
    orgId = result.orgId;
  } catch {
    redirect(`${path}?error=acceptance`);
  }
  (await cookies()).set(ORG_COOKIE, orgId, {
    httpOnly: true, sameSite: 'lax', secure: process.env['NODE_ENV'] === 'production',
    path: '/', maxAge: 60 * 60 * 24 * 365,
  });
  redirect(authContinuePath('/dashboard'));
}

/** Explicit POST only. GET must never consume a one-use Auth email token. */
export async function verifyRecipientInvitation(kind: InvitationKind, token: string, formData: FormData): Promise<void> {
  const path = invitationPath(kind, token);
  const invitation = await loadRecipientInvitation(kind, token);
  const authToken = formData.get('auth_token_hash');
  if (!invitation || invitation.state !== 'pending') redirect(`${path}?error=unavailable`);
  const existing = await currentUser();
  if (existing !== null) {
    // A link cannot silently replace an already signed-in account.
    redirect(existing.email?.trim().toLowerCase() === invitation.email.toLowerCase() ? path : `${path}?error=account`);
  }
  if (!validAuthInvitationToken(authToken) || !supabaseConfigured()) redirect(`${path}?error=verification`);

  let verified = false;
  try {
    const client = await supabaseServerClient();
    // The pinned SDK can return verifyOtp before its initialization has allowed
    // SSR cookie subscribers to flush. Await initialization in this writable action.
    const initialized = await client.auth.initialize();
    if (!initialized.error) {
      const result = await client.auth.verifyOtp({ token_hash: authToken, type: 'invite' });
      const user = result.data.user;
      verified = !result.error && result.data.session !== null && user !== null &&
        user.email?.trim().toLowerCase() === invitation.email.toLowerCase() && Boolean(user.email_confirmed_at);
      if (!verified && result.data.session !== null) await client.auth.signOut({ scope: 'local' });
    }
  } catch {
    // Provider errors may contain tokens. Lost responses are uncertain, never
    // a reason to repeat verification or create another Auth account here.
  }
  if (!verified) redirect(`${path}?error=verification`);
  redirect(`/recover-password?${new URLSearchParams({ next: path, setup: '1' }).toString()}`);
}
