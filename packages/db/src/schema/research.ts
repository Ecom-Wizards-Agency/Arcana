import { boolean, foreignKey, jsonb, pgTable, primaryKey, text, unique, uuid } from 'drizzle-orm/pg-core';
import type { BrandLensBucket, BrandLensDecision, DaypartingModifiers, DaypartingReviewRecord, DaypartingScheduleStatus } from '@wizard-ads/shared';
import { ts } from './columns.js';
import { adProfiles, authUsers, orgs } from './tenancy.js';
export const brandLensOverrides = pgTable('brand_lens_overrides', {
  orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  profileId: uuid('profile_id').notNull(),
  normalizedKeyword: text('normalized_keyword').notNull(),
  bucket: text('bucket').$type<BrandLensBucket>().notNull(),
  decision: text('decision').$type<BrandLensDecision>().notNull(),
  decidedBy: uuid('decided_by').notNull().references(() => authUsers.id),
  decidedAt: ts('decided_at').notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.orgId, t.profileId, t.normalizedKeyword] }), foreignKey({
  columns: [t.orgId, t.profileId],
  foreignColumns: [adProfiles.orgId, adProfiles.id]
}).onDelete('cascade')]);
export const daypartingSchedules = pgTable('dayparting_schedules', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  profileId: uuid('profile_id').notNull(),
  name: text('name').notNull(),
  timezone: text('timezone').notNull(),
  modifiers: jsonb('modifiers').$type<DaypartingModifiers>().notNull(),
  status: text('status').$type<DaypartingScheduleStatus>().notNull().default('draft'),
  reviewedBy: uuid('reviewed_by').references(() => authUsers.id),
  reviewedAt: ts('reviewed_at'),
  reviewRecord: jsonb('review_record').$type<DaypartingReviewRecord>(),
  enabledAt: ts('enabled_at'),
  pausedAt: ts('paused_at'),
  sourceProposalId: uuid('source_proposal_id'),
  nextRunAt: ts('next_run_at'),
  cadenceLimits: jsonb('cadence_limits'),
  profileKillSwitch: boolean('profile_kill_switch'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, (t) => [unique().on(t.orgId, t.profileId, t.id), foreignKey({
  columns: [t.orgId, t.profileId],
  foreignColumns: [adProfiles.orgId, adProfiles.id]
}).onDelete('cascade')]);
export const daypartingScheduleCampaigns = pgTable('dayparting_schedule_campaigns', {
  orgId: uuid('org_id').notNull(),
  profileId: uuid('profile_id').notNull(),
  scheduleId: uuid('schedule_id').notNull(),
  campaignId: text('campaign_id').notNull(),
  active: boolean('active').notNull().default(false),
}, (t) => [primaryKey({ columns: [t.scheduleId, t.campaignId] }), foreignKey({
  columns: [t.orgId, t.profileId, t.scheduleId],
  foreignColumns: [daypartingSchedules.orgId, daypartingSchedules.profileId, daypartingSchedules.id]
}).onDelete('cascade')]);
