import { pgTable, uuid, unique, foreignKey } from 'drizzle-orm/pg-core';
import { authUsers } from './tenancy.js';
import { spWritePlans } from './sp-writes.js';
import { ts } from './columns.js';
export const spWriteRestoreProposals=pgTable('sp_write_restore_proposals',{
  planId:uuid('plan_id').primaryKey(),orgId:uuid('org_id').notNull(),profileId:uuid('profile_id').notNull(),
  sourceBatchId:uuid('source_batch_id').notNull(),createdBy:uuid('created_by').notNull().references(()=>authUsers.id),createdAt:ts('created_at').notNull().defaultNow(),
},t=>[unique().on(t.orgId,t.profileId,t.planId),
  foreignKey({columns:[t.orgId,t.profileId,t.planId],foreignColumns:[spWritePlans.orgId,spWritePlans.profileId,spWritePlans.planId]}).onDelete('cascade'),
]);
export const spWriteRestoreReviews=pgTable('sp_write_restore_reviews',{
  planId:uuid('plan_id').primaryKey(),orgId:uuid('org_id').notNull(),profileId:uuid('profile_id').notNull(),
  reviewedBy:uuid('reviewed_by').notNull().references(()=>authUsers.id),reviewedAt:ts('reviewed_at').notNull().defaultNow(),
},t=>[foreignKey({columns:[t.orgId,t.profileId,t.planId],foreignColumns:[spWriteRestoreProposals.orgId,spWriteRestoreProposals.profileId,spWriteRestoreProposals.planId]}).onDelete('cascade')]);
