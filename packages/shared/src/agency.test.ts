import { describe, expect, it } from 'vitest';
import {
  AuthenticatedIdentity, OrgActor, OrgRole, OrgCapability,
  ORG_CAPABILITY_ROLES, TeamInvitationRole,
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
});
