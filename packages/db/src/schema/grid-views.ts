import { foreignKey, jsonb, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import type { GridSavedView } from '@wizard-ads/shared';
import { ts } from './columns.js';
import { orgs, adProfiles, authUsers } from './tenancy.js';

export const gridViews = pgTable('grid_views', {
  orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  id: text('id').notNull(),
  profileId: uuid('profile_id'),
  ownerId: uuid('owner_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  view: jsonb('view').$type<GridSavedView>().notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.orgId, t.id] }),
  foreignKey({ columns: [t.orgId, t.profileId], foreignColumns: [adProfiles.orgId, adProfiles.id] }).onDelete('cascade'),
]);
