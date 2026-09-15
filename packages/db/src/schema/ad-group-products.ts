import { foreignKey, pgTable, primaryKey, text, uuid, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { ts } from './columns.js';
import { orgs, adProfiles, authUsers } from './tenancy.js';
import { adGroups } from './entities.js';
export const adGroupProductAssignments = pgTable('ad_group_product_assignments', {
  orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  profileId: uuid('profile_id').notNull(),
  adGroupId: text('ad_group_id').notNull(),
  asin: text('asin').notNull(),
  assignedBy: uuid('assigned_by').notNull().references(() => authUsers.id),
  assignedAt: ts('assigned_at').notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.orgId, t.profileId, t.adGroupId] }),
  foreignKey({ columns: [t.orgId, t.profileId], foreignColumns: [adProfiles.orgId, adProfiles.id] }).onDelete('cascade'),
  foreignKey({ columns: [t.profileId, t.adGroupId], foreignColumns: [adGroups.profileId, adGroups.amazonId] }).onDelete('cascade'),
  check('ad_group_product_assignments_asin_check', sql`${t.asin} ~ '^[A-Z0-9]{10}$'`),
]);
