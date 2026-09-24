import { foreignKey, jsonb, pgTable, primaryKey, text, uuid, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { ts } from './columns.js';
import { orgs, adProfiles, authUsers } from './tenancy.js';
import { adGroups } from './entities.js';
export const adGroupProductAssignments = pgTable('ad_group_product_assignments', {
  orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  profileId: uuid('profile_id').notNull(),
  adGroupId: text('ad_group_id').notNull(),
  // Null only for an unassigned derivation; a manual row always names its actor.
  asin: text('asin'),
  assignedBy: uuid('assigned_by').references(() => authUsers.id),
  assignedAt: ts('assigned_at').notNull().defaultNow(),
  source: text('source', { enum: ['manual', 'derived', 'derived_parent', 'proposed', 'unassigned'] }).notNull().default('manual'),
  derivedAt: ts('derived_at'),
  /** The worker's latest rule outcome; kept beneath a manual choice as its revert target. */
  derivation: jsonb('derivation'),
}, (t) => [
  primaryKey({ columns: [t.orgId, t.profileId, t.adGroupId] }),
  foreignKey({ columns: [t.orgId, t.profileId], foreignColumns: [adProfiles.orgId, adProfiles.id] }).onDelete('cascade'),
  foreignKey({ columns: [t.profileId, t.adGroupId], foreignColumns: [adGroups.profileId, adGroups.amazonId] }).onDelete('cascade'),
  check('ad_group_product_assignments_asin_check', sql`${t.asin} ~ '^[A-Z0-9]{10}$'`),
  check('product_assignment_source', sql`${t.source} in ('manual','derived','derived_parent','proposed','unassigned')`),
  check('product_assignment_shape', sql`(${t.source}='unassigned' and ${t.asin} is null or ${t.source}<>'unassigned' and ${t.asin} is not null) and (${t.source}<>'manual' or ${t.assignedBy} is not null)`),
]);
