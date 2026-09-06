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

/** Server-to-database issuance; the raw invitation token is never stored. */
export const TeamInvitationIssue = z.object({
  email: z.email().max(320).trim().toLowerCase(),
  role: TeamInvitationRole,
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  tokenPrefix: z.string().regex(/^[A-Za-z0-9_-]{12}$/),
}).strict();
export type TeamInvitationIssue = z.infer<typeof TeamInvitationIssue>;

export const MemberRoleChange = z.object({ userId: Uuid, role: OrgRole }).strict();
export type MemberRoleChange = z.infer<typeof MemberRoleChange>;
