import { createHash, randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import type { QueryHandle } from '@wizard-ads/db';
import {
  agencyBootstrapDeliveryContext, provisionAgency, recordAgencyInvitationLinkIssued,
  reissueAgencyBootstrapInvitation, revokeAgencyBootstrapInvitation,
} from '@wizard-ads/db/operator';
import type { AgencyProvisionReceipt, InvitationDeliveryStatus } from '@wizard-ads/shared';
import type { AgencyCommand } from './command.js';
import { invitationOrigin } from './command.js';

export type SendInvitation = (email: string, redirectTo: string) => Promise<InvitationDeliveryStatus>;
/** Link delivery: returns the link to hand over; sends nothing. */
export type IssueInvitationLink = (email: string, invitationUrl: string) => Promise<{ status: InvitationDeliveryStatus; url: string }>;
export type AgencyCommandResult =
  | { operation: 'revoke'; requestId: string; expectedGeneration: number; changed: boolean }
  | {
      operation: 'provision' | 'reissue'; receipt: AgencyProvisionReceipt;
      /**
       * Shown once. Treat this URL as a private invitation credential. In link
       * delivery for a new account it carries the one-time Auth token hash.
       */
      invitationUrl: string | null;
      delivery: InvitationDeliveryStatus | 'not_requested' | 'token_unavailable';
    };

/** A retry can recover agency state, never an unknown original bearer token. */
export async function runAgencyCommand(command: AgencyCommand, options: {
  handle: QueryHandle; appOrigin?: string; sendInvitation?: SendInvitation; issueLink?: IssueInvitationLink;
}): Promise<AgencyCommandResult> {
  if (command.operation === 'revoke') {
    const changed = await revokeAgencyBootstrapInvitation(options.handle, {
      requestId: command.requestId, expectedGeneration: command.expectedGeneration,
    });
    return { operation: 'revoke', requestId: command.requestId, expectedGeneration: command.expectedGeneration, changed };
  }
  const origin = invitationOrigin(options.appOrigin);
  if (command.sendEmail && !options.sendInvitation) throw new Error('Auth invitation delivery is not configured.');
  const raw = randomBytes(32).toString('base64url');
  const token = { tokenHash: createHash('sha256').update(raw).digest('hex'), tokenPrefix: raw.slice(0, 12) };
  const receipt = command.operation === 'provision'
    ? await provisionAgency(options.handle, { ...command.request, token })
    : await reissueAgencyBootstrapInvitation(options.handle, {
        requestId: command.requestId, expectedGeneration: command.expectedGeneration, token,
      });
  if (!receipt.tokenMatches || receipt.state !== 'pending') {
    return { operation: command.operation, receipt, invitationUrl: null, delivery: 'token_unavailable' };
  }
  let invitationUrl = new URL(`/agency-invite/${raw}`, origin).toString();
  let delivery: InvitationDeliveryStatus | 'not_requested' = 'not_requested';
  if (!command.sendEmail && options.issueLink) {
    try {
      const context = await agencyBootstrapDeliveryContext(options.handle, receipt.requestId, token.tokenHash);
      if (context.generation !== receipt.generation) throw new Error('Invitation changed before delivery.');
      const link = await options.issueLink(context.ownerEmail, invitationUrl);
      // Audit before showing: an unrecorded account link is never printed.
      await recordAgencyInvitationLinkIssued(options.handle, { receipt, status: link.status });
      invitationUrl = link.url;
      delivery = link.status;
    } catch {
      // No automatic retry. The plain application link remains valid for an
      // existing account; reissue explicitly to request a new account link.
      delivery = 'uncertain';
    }
  }
  if (command.sendEmail) {
    try {
      const context = await agencyBootstrapDeliveryContext(options.handle, receipt.requestId, token.tokenHash);
      if (context.generation !== receipt.generation) throw new Error('Invitation changed before delivery.');
      delivery = await options.sendInvitation!(context.ownerEmail, invitationUrl);
    } catch {
      // No automatic resend after either a lost context or provider response.
      delivery = 'uncertain';
    }
  }
  return { operation: command.operation, receipt, invitationUrl, delivery };
}

/** Separate operator Auth credential, used only for a mailbox-verifying invite. */
export function authInvitationSender(url: string, key: string): SendInvitation {
  const client = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  return async (email, redirectTo) => {
    try {
      const result = await client.auth.admin.inviteUserByEmail(email, { redirectTo });
      if (result.error?.code === 'email_exists' || result.error?.code === 'user_already_exists') return 'existing_account';
      if (result.error) return !result.error.status || result.error.status >= 500 ? 'uncertain' : 'failed';
      return result.data.user?.email?.trim().toLowerCase() === email.toLowerCase() ? 'accepted_by_provider' : 'uncertain';
    } catch {
      return 'uncertain';
    }
  };
}

/** Link delivery with the operator Auth credential. Creates a missing account; sends no email. */
export function authInvitationLinker(url: string, key: string): IssueInvitationLink {
  const client = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  return async (email, invitationUrl) => {
    try {
      const result = await client.auth.admin.generateLink({ type: 'invite', email, options: { redirectTo: invitationUrl } });
      if (result.error?.code === 'email_exists' || result.error?.code === 'user_already_exists') return { status: 'existing_account', url: invitationUrl };
      if (result.error) return { status: !result.error.status || result.error.status >= 500 ? 'uncertain' : 'failed', url: invitationUrl };
      const tokenHash = result.data.properties?.hashed_token;
      if (typeof tokenHash !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(tokenHash) ||
          result.data.user?.email?.trim().toLowerCase() !== email.trim().toLowerCase()) return { status: 'uncertain', url: invitationUrl };
      const link = new URL(invitationUrl);
      link.searchParams.set('token_hash', tokenHash);
      return { status: 'link_ready', url: link.toString() };
    } catch {
      return { status: 'uncertain', url: invitationUrl };
    }
  };
}
