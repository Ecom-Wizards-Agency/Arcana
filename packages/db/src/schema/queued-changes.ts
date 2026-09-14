import { foreignKey, index, jsonb, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import type { QueuedBidChange, QueuedBidRequest, TargetBidContext } from '@wizard-ads/shared';
import { ts } from './columns.js';
import { orgs, adProfiles, authUsers } from './tenancy.js';
export const queuedChanges = pgTable('queued_changes', {
  id: uuid('id').primaryKey(), orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  profileId: uuid('profile_id').notNull(), targetId: text('target_id').notNull(),
  createdBy: uuid('created_by').notNull().references(() => authUsers.id), createdAt: ts('created_at').notNull().defaultNow(),
  context: jsonb('context').$type<TargetBidContext>().notNull(), request: jsonb('request').$type<QueuedBidRequest>().notNull(),
  checks: jsonb('checks').$type<QueuedBidChange['checks']>().notNull(),
}, (t) => [index('queued_changes_scope_time').on(t.orgId,t.profileId,t.targetId,t.createdAt), unique().on(t.orgId, t.profileId, t.id), foreignKey({ columns: [t.orgId, t.profileId], foreignColumns: [adProfiles.orgId, adProfiles.id] }).onDelete('cascade')]);
export const queuedChangeApprovals = pgTable('queued_change_approvals', {
  changeId: uuid('change_id').primaryKey(), orgId: uuid('org_id').notNull(), profileId: uuid('profile_id').notNull(),
  approvedBy: uuid('approved_by').notNull().references(() => authUsers.id), approvedAt: ts('approved_at').notNull().defaultNow(),
}, (t) => [foreignKey({ columns: [t.orgId, t.profileId, t.changeId], foreignColumns: [queuedChanges.orgId, queuedChanges.profileId, queuedChanges.id] }).onDelete('cascade')]);
