/**
 * Agency identity and role contracts. These values identify a verified server
 * caller; parsing an actor is never authentication or proof of membership.
 * Installation provisioning is separate from every organization role.
 */
import { z } from 'zod';
import { Uuid } from './primitives.js';

export const AuthenticatedIdentity = z.object({ userId: Uuid }).strict();
export type AuthenticatedIdentity = z.infer<typeof AuthenticatedIdentity>;

export const OrgActor = AuthenticatedIdentity.extend({ orgId: Uuid }).strict();
export type OrgActor = z.infer<typeof OrgActor>;

export const OrgRole = z.enum(['owner', 'admin', 'analyst', 'viewer']);
export type OrgRole = z.infer<typeof OrgRole>;

export const OrgCapability = z.enum([
  'read',
  'editTargets',
  'toggleSync',
  'manageConnection',
  'manageMembers',
  'triageFeedback',
  'exportBatches',
  'manageExperiments',
]);
export type OrgCapability = z.infer<typeof OrgCapability>;

/** One policy table for presentation, server composition and SQL policy tests. */
export const ORG_CAPABILITY_ROLES = {
  read: ['owner', 'admin', 'analyst', 'viewer'],
  editTargets: ['owner', 'admin', 'analyst'],
  toggleSync: ['owner', 'admin'],
  manageConnection: ['owner', 'admin'],
  manageMembers: ['owner', 'admin'],
  triageFeedback: ['owner', 'admin'],
  exportBatches: ['owner', 'admin'],
  manageExperiments: ['owner', 'admin', 'analyst'],
} as const satisfies Readonly<Record<OrgCapability, readonly OrgRole[]>>;

/** Team invitations cannot establish or transfer agency ownership. */
export const TeamInvitationRole = OrgRole.exclude(['owner']);
export type TeamInvitationRole = z.infer<typeof TeamInvitationRole>;
