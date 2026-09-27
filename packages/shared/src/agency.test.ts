import { describe, expect, it } from 'vitest';
import {
  AuthenticatedIdentity, OrgActor, OrgRole, OrgCapability,
  ORG_CAPABILITY_ROLES, TeamInvitationRole, TeamInvitationIssue,
  AgencyProvisionCommand, AgencyProvisionReceipt, BootstrapReissueCommand,
  BootstrapAcceptanceReceipt, InvitationDeliveryStatus, InvitationDeliveryMode,
  ACCESS_LINK_AUDIT_ACTIONS, MEMBER_RECOVERY_LINK_INTERVAL_MINUTES,
  MemberRecoveryLinkRequest, MemberRecoveryLinkRefusal,
} from './agency.js';

const userId = '11111111-1111-4111-8111-111111111111';
const orgId = '22222222-2222-4222-8222-222222222222';

describe('agency authority contracts', () => {
  it('separates pre-membership identity from an exact selected organization', () => {
    expect(AuthenticatedIdentity.parse({ userId })).toEqual({ userId });
    expect(OrgActor.parse({ userId, orgId })).toEqual({ userId, orgId });
    expect(OrgActor.safeParse({ userId }).success).toBe(false);
    expect(AuthenticatedIdentity.safeParse({ userId, orgId }).success).toBe(false);
    expect(OrgActor.safeParse({ userId, orgId, role: 'owner' }).success).toBe(false);
    expect(OrgActor.safeParse({ userId, orgId: 'invalid' }).success).toBe(false);
  });

  it('has no installation-wide or support role and cannot invite an owner through the team contract', () => {
    expect(OrgRole.options).toEqual(['owner', 'admin', 'analyst', 'viewer']);
    expect(TeamInvitationRole.options).toEqual(['admin', 'analyst', 'viewer']);
    expect(OrgRole.safeParse('superuser').success).toBe(false);
    expect(TeamInvitationRole.safeParse('owner').success).toBe(false);
    const issue = { email: 'owner@example.test', role: 'analyst', tokenHash: 'a'.repeat(64), tokenPrefix: 'b'.repeat(12) };
    expect(TeamInvitationIssue.safeParse(issue).success).toBe(true);
    expect(TeamInvitationIssue.safeParse({ ...issue, role: 'owner' }).success).toBe(false);
    expect(TeamInvitationIssue.safeParse({ ...issue, invitedBy: userId }).success).toBe(false);
  });

  it('preserves the existing role policy without adding platform provisioning authority', () => {
    expect(OrgCapability.options).toHaveLength(8);
    expect(ORG_CAPABILITY_ROLES).toEqual({
      read: ['owner', 'admin', 'analyst', 'viewer'],
      editTargets: ['owner', 'admin', 'analyst'],
      toggleSync: ['owner', 'admin'],
      manageConnection: ['owner', 'admin'],
      manageMembers: ['owner', 'admin'],
      triageFeedback: ['owner', 'admin'],
      exportBatches: ['owner', 'admin'],
      manageExperiments: ['owner', 'admin', 'analyst'],
    });
    expect(OrgCapability.safeParse('provisionAgency').success).toBe(false);
  });

  it('separates first-owner provisioning from team invitations and arbitrary membership input', () => {
    const command = {
      requestId: userId, name: '  Synthetic agency  ', slug: 'synthetic-agency',
      ownerEmail: '  Owner@Example.Test ', token: { tokenHash: 'a'.repeat(64), tokenPrefix: 'b'.repeat(12) },
    };
    expect(AgencyProvisionCommand.parse(command)).toMatchObject({ name: 'Synthetic agency', ownerEmail: 'owner@example.test' });
    for (const extra of [{ role: 'owner' }, { orgId }, { operatorUserId: userId }]) {
      expect(AgencyProvisionCommand.safeParse({ ...command, ...extra }).success).toBe(false);
    }
    for (const slug of ['UPPER', '../foreign', '-leading', 'trailing-', 'double--dash']) {
      expect(AgencyProvisionCommand.safeParse({ ...command, slug }).success).toBe(false);
    }
    expect(TeamInvitationIssue.safeParse({ ...command, role: 'owner' }).success).toBe(false);
  });

  it('keeps retry and token-generation outcomes explicit without recovering a bearer token', () => {
    const receipt = { requestId: userId, orgId, invitationId: userId, generation: 1, state: 'pending', outcome: 'existing', tokenMatches: false };
    expect(AgencyProvisionReceipt.parse(receipt).tokenMatches).toBe(false);
    expect(AgencyProvisionReceipt.safeParse({ ...receipt, token: 'raw-token' }).success).toBe(false);
    expect(BootstrapReissueCommand.safeParse({ requestId: userId, expectedGeneration: 0, token: { tokenHash: 'a'.repeat(64), tokenPrefix: 'b'.repeat(12) } }).success).toBe(false);
    expect(BootstrapAcceptanceReceipt.safeParse({ orgId, invitationId: userId, generation: 1, outcome: 'accepted', role: 'owner' }).success).toBe(false);
  });

  it('adds link delivery beside email without changing the existing delivery outcomes', () => {
    expect(InvitationDeliveryMode.options).toEqual(['link', 'email']);
    expect(InvitationDeliveryStatus.options).toEqual([
      'accepted_by_provider', 'existing_account', 'unavailable', 'failed', 'uncertain', 'link_ready',
    ]);
    expect(ACCESS_LINK_AUDIT_ACTIONS).toEqual({
      team: 'team.invitation_link_issued',
      agency: 'agency.invitation_link_issued',
      recovery: 'auth.recovery_link_issued',
    });
  });

  it('accepts only a member identity for an owner/admin reset link', () => {
    expect(MEMBER_RECOVERY_LINK_INTERVAL_MINUTES).toBe(10);
    expect(MemberRecoveryLinkRequest.parse({ userId })).toEqual({ userId });
    expect(MemberRecoveryLinkRequest.safeParse({ userId, email: 'member@example.test' }).success).toBe(false);
    expect(MemberRecoveryLinkRequest.safeParse({ userId: 'invalid' }).success).toBe(false);
    expect(MemberRecoveryLinkRefusal.options).toEqual(['not_member', 'self', 'owner_only', 'other_orgs', 'rate_limited']);
  });
});
