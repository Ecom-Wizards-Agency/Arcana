import { createHash, randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import type { QueryHandle } from '@wizard-ads/db';
import {
  agencyBootstrapDeliveryContext, provisionAgency, reissueAgencyBootstrapInvitation, revokeAgencyBootstrapInvitation,
} from '@wizard-ads/db/operator';
import type { AgencyProvisionReceipt, InvitationDeliveryStatus } from '@wizard-ads/shared';
import type { AgencyCommand } from './command.js';
import { invitationOrigin } from './command.js';

export type SendInvitation = (email: string, redirectTo: string) => Promise<InvitationDeliveryStatus>;
export type AgencyCommandResult =
  | { operation: 'revoke'; requestId: string; expectedGeneration: number; changed: boolean }
  | {
      operation: 'provision' | 'reissue'; receipt: AgencyProvisionReceipt;
      /** Shown once. Treat this URL as a private invitation credential. */
      invitationUrl: string | null;
      delivery: InvitationDeliveryStatus | 'not_requested' | 'token_unavailable';
    };

/** A retry can recover agency state, never an unknown original bearer token. */
export async function runAgencyCommand(command: AgencyCommand, options: {
  handle: QueryHandle; appOrigin?: string; sendInvitation?: SendInvitation;
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
  const invitationUrl = new URL(`/agency-invite/${raw}`, origin).toString();
  let delivery: InvitationDeliveryStatus | 'not_requested' = 'not_requested';
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
