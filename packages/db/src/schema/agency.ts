/** Private first-owner invitation ledger; SQL commands own every transition. */
import { integer, pgSchema, text, uuid } from 'drizzle-orm/pg-core';
import { ts } from './columns.js';
import { authUsers, orgs } from './tenancy.js';

export const agencyBootstrapInvitations = pgSchema('app').table('agency_bootstrap_invitations', {
  id: uuid('id').primaryKey().defaultRandom(),
  requestId: uuid('request_id').notNull().unique(),
  orgId: uuid('org_id').notNull().unique().references(() => orgs.id, { onDelete: 'cascade' }),
  requestedName: text('requested_name').notNull(),
  requestedSlug: text('requested_slug').notNull(),
  ownerEmail: text('owner_email').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  tokenPrefix: text('token_prefix').notNull(),
  generation: integer('generation').notNull().default(1),
  expiresAt: ts('expires_at').notNull(),
  revokedAt: ts('revoked_at'),
  acceptedAt: ts('accepted_at'),
  acceptedBy: uuid('accepted_by').references(() => authUsers.id, { onDelete: 'set null' }),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});
