import { sql } from 'drizzle-orm';
import { check, doublePrecision, foreignKey, pgTable, uuid } from 'drizzle-orm/pg-core';
import { ts } from './columns.js';
import { adProfiles, orgs } from './tenancy.js';

export const marketPositionSettings = pgTable('market_position_settings', {
  profileId: uuid('profile_id').primaryKey(),
  orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  thresholdPercent: doublePrecision('threshold_percent').notNull().default(15),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, (t) => [
  check('market_position_settings_threshold_check', sql`${t.thresholdPercent} >= 0 and ${t.thresholdPercent} <= 100`),
  foreignKey({ name: 'market_position_settings_org_profile_fkey', columns: [t.orgId, t.profileId], foreignColumns: [adProfiles.orgId, adProfiles.id] }).onDelete('cascade'),
]);
