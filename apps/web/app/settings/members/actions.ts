'use server';

import { revalidatePath } from 'next/cache';
import { authorize, isOrgRole } from '../../../src/auth/roles';
import type { OrgRole } from '../../../src/auth/roles';
import { gateAction } from '../../../src/auth/guard';
import { currentUser } from '../../../src/auth/session';
import {
  createInvitation,
  revokeInvitation,
} from '../../../src/data/invitations';
import type { InvitationRecord } from '../../../src/data/invitations';
import { listMembers, removeMember, updateMemberRole } from '../../../src/data/members';
import type { InvitationDeliveryStatus } from '@wizard-ads/shared';
import { createMemberRecoveryLink } from '../../../src/auth/recovery';
import {
  createTeamInvitationLink, deliverTeamInvitation, invitationLinkInstruction, invitationLinkStatusLabel,
  teamInvitationDeliveryMessage,
} from '../../../src/invitations/delivery';

export type MemberActionResult =
  | { status: 'idle' }
  | { status: 'ok'; message: string }
  | { status: 'error'; message: string };

export type InviteActionResult =
  | { status: 'idle' }
  | { status: 'error'; message: string }
  | {
      status: 'ok';
      message: string;
      invitation: InvitationRecord;
      /** Exists only in this action response. It is never persisted or put in a URL. */
      inviteUrl: string;
      /** The plaintext invitation token, posted back only for the optional email. */
      token: string;
      delivery: InvitationDeliveryStatus;
      deliveryLabel: string;
    };

export type EmailDeliveryResult =
  | { status: 'idle' }
  | { status: 'error'; message: string }
  | { status: 'ok'; delivery: InvitationDeliveryStatus; label: string; message: string };

export type ResetLinkResult =
  | { status: 'idle' }
  | { status: 'error'; message: string }
  | {
      status: 'ok';
      /** Exists only in this action response. It is never persisted or logged. */
      url: string;
      message: string;
    };

/**
 * Create one non-owner invitation and return its link exactly once. Link
 * delivery is the default: nothing is emailed unless the manager asks.
 */
export async function createInvite(
  _previous: InviteActionResult,
  formData: FormData,
): Promise<InviteActionResult> {
  try {
    const { handle, active } = await gateAction();
    authorize(active.role, 'manageMembers');

    const role = roleFrom(formData.get('role'));
    if (role === 'owner') {
      return errorResult('Invitations may grant admin, analyst, or viewer access.');
    }

    // Links are built from authOrigin(); refuse before issuing when the
    // installation origin they depend on is not configured.
    const appUrl = process.env['WIZARD_ADS_APP_URL']?.replace(/\/+$/, '');
    if (!appUrl) {
      return errorResult('Invitation links are not configured. Set WIZARD_ADS_APP_URL.');
    }
    const actor = await actorId();
    const issued = await createInvitation(handle, {
      orgId: active.orgId,
      email: text(formData.get('email')),
      role,
      invitedBy: actor.id,
    });
    let link: Awaited<ReturnType<typeof createTeamInvitationLink>>;
    try {
      link = await createTeamInvitationLink(handle, { orgId: active.orgId, userId: actor.id }, issued.token);
    } catch {
      revalidatePath('/settings/members');
      return errorResult('The invitation is saved, but its link could not be recorded. Revoke it and invite again.');
    }

    revalidatePath('/settings/members');
    return {
      status: 'ok',
      message: invitationLinkInstruction(link.status, issued.invitation.email),
      invitation: issued.invitation,
      inviteUrl: link.url,
      token: issued.token,
      delivery: link.status,
      deliveryLabel: invitationLinkStatusLabel(link.status),
    };
  } catch (error) {
    return memberError(error, 'The invitation could not be created.');
  }
}

/** The secondary path: ask Auth to email the open invitation. Needs SMTP. */
export async function sendInviteEmail(
  _previous: EmailDeliveryResult,
  formData: FormData,
): Promise<EmailDeliveryResult> {
  try {
    const { handle, active } = await gateAction();
    authorize(active.role, 'manageMembers');
    const actor = await actorId();
    const token = requiredText(formData.get('token'), 'No invitation was selected.');
    const delivery = await deliverTeamInvitation(handle, { orgId: active.orgId, userId: actor.id }, token);
    return {
      status: 'ok',
      delivery,
      label: delivery === 'accepted_by_provider' ? 'Email accepted for delivery' : 'Email not sent',
      message: teamInvitationDeliveryMessage(delivery),
    };
  } catch (error) {
    return memberError(error, 'The email could not be requested.');
  }
}

/** Owner/admin-issued password reset link for another member, shown once. */
export async function createResetLink(
  _previous: ResetLinkResult,
  formData: FormData,
): Promise<ResetLinkResult> {
  try {
    const { handle, active } = await gateAction();
    authorize(active.role, 'manageMembers');
    const actor = await actorId();
    const userId = requiredText(formData.get('userId'), 'No member was selected.');
    const result = await createMemberRecoveryLink(handle, { orgId: active.orgId, userId: actor.id }, userId);
    if (result.status === 'error') return errorResult(result.message);
    return {
      status: 'ok',
      url: result.url,
      message: `Send this link to ${result.email} yourself; it lets them choose a new password. It is shown only now.`,
    };
  } catch (error) {
    return memberError(error, 'The reset link could not be created.');
  }
}

/** Revoke one still-open invitation in the active organisation. */
export async function revokeInvite(
  _previous: MemberActionResult,
  formData: FormData,
): Promise<MemberActionResult> {
  try {
    const { handle, active } = await gateAction();
    authorize(active.role, 'manageMembers');
    const actor = await actorId();
    const revoked = await revokeInvitation(
      handle,
      active.orgId,
      requiredText(formData.get('invitationId'), 'No invitation was selected.'),
      actor.id,
    );
    if (!revoked) return errorResult('That invitation is no longer open.');

    revalidatePath('/settings/members');
    return { status: 'ok', message: 'Invitation revoked.' };
  } catch (error) {
    return memberError(error, 'The invitation could not be revoked.');
  }
}

/** Save one role, with owner transitions reserved to an owner. */
export async function changeMemberRole(
  _previous: MemberActionResult,
  formData: FormData,
): Promise<MemberActionResult> {
  try {
    const { handle, active } = await gateAction();
    authorize(active.role, 'manageMembers');
    const actor = await actorId();
    const userId = requiredText(formData.get('userId'), 'No member was selected.');
    const role = roleFrom(formData.get('role'));
    const members = await listMembers(handle, { orgId: active.orgId, userId: actor.id });
    const target = members.find((member) => member.userId === userId);
    if (!target) return errorResult('That person is no longer a member.');

    if ((target.role === 'owner' || role === 'owner') && active.role !== 'owner') {
      return errorResult('Only an owner can assign or remove the owner role.');
    }
    if (
      target.role === 'owner' &&
      role !== 'owner' &&
      members.filter((member) => member.role === 'owner').length === 1
    ) {
      return errorResult('The organisation must keep at least one owner.');
    }
    if (target.role === role) return { status: 'ok', message: 'The role is already up to date.' };

    const changed = await updateMemberRole(handle, {
      orgId: active.orgId,
      userId,
      actorId: actor.id,
      role,
    });
    if (changed !== 1) {
      return errorResult(
        target.role === 'owner'
          ? 'The organisation must keep at least one owner.'
          : 'The role could not be changed. Reload and try again.',
      );
    }

    revalidatePath('/settings/members');
    return { status: 'ok', message: `Role changed to ${role}.` };
  } catch (error) {
    return memberError(error, 'The role could not be changed.');
  }
}

/** Remove one other member, never the acting user and never the final owner. */
export async function removeOrgMember(
  _previous: MemberActionResult,
  formData: FormData,
): Promise<MemberActionResult> {
  try {
    const { handle, active } = await gateAction();
    authorize(active.role, 'manageMembers');
    const actor = await actorId();
    const userId = requiredText(formData.get('userId'), 'No member was selected.');
    if (userId === actor.id) return errorResult('You cannot remove yourself.');

    const members = await listMembers(handle, { orgId: active.orgId, userId: actor.id });
    const target = members.find((member) => member.userId === userId);
    if (!target) return errorResult('That person is no longer a member.');
    if (target.role === 'owner' && active.role !== 'owner') {
      return errorResult('Only an owner can remove another owner.');
    }
    if (
      target.role === 'owner' &&
      members.filter((member) => member.role === 'owner').length === 1
    ) {
      return errorResult('The organisation must keep at least one owner.');
    }

    const removed = await removeMember(handle, {
      orgId: active.orgId,
      userId,
      actorId: actor.id,
    });
    if (removed !== 1) {
      return errorResult(
        target.role === 'owner'
          ? 'The organisation must keep at least one owner.'
          : 'The member could not be removed. Reload and try again.',
      );
    }

    revalidatePath('/settings/members');
    return { status: 'ok', message: 'Member removed.' };
  } catch (error) {
    return memberError(error, 'The member could not be removed.');
  }
}

/** `gateAction` deliberately returns no user; this keeps its existing narrow contract intact. */
async function actorId(): Promise<{ id: string }> {
  const user = await currentUser();
  if (!user) throw new Error('not signed in');
  return user;
}

function roleFrom(value: FormDataEntryValue | null): OrgRole {
  if (!isOrgRole(value)) throw new Error('Choose a valid organisation role.');
  return value;
}

function text(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value.trim() : '';
}

function requiredText(value: FormDataEntryValue | null, message: string): string {
  const result = text(value);
  if (!result) throw new Error(message);
  return result;
}

function errorResult(message: string): { status: 'error'; message: string } {
  return { status: 'error', message };
}

function memberError(error: unknown, fallback: string): { status: 'error'; message: string } {
  if (error instanceof Error) {
    if (error.name === 'Forbidden') return errorResult('Only admins and owners can manage members.');
    const safeMessages = [
      'Enter an email address.',
      'Invitations may grant admin, analyst, or viewer access.',
      'That address is already a member.',
      'That address already has a pending invitation.',
      'Choose a valid organisation role.',
      'No invitation was selected.',
      'No member was selected.',
    ];
    if (safeMessages.includes(error.message)) return errorResult(error.message);
  }
  return errorResult(fallback);
}
