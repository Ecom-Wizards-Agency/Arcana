import { date, foreignKey, index, integer, numeric, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { ts } from './columns.js';
import { adProfiles, authUsers, orgs } from './tenancy.js';
export const timelineEvents = pgTable('timeline_events', {
    id: uuid('id').primaryKey().defaultRandom(), orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
    profileId: uuid('profile_id').notNull(), name: text('name').notNull(), kind: text('kind').notNull(),
    startOn: date('start_on').notNull(), endOn: date('end_on'), scopeText: text('scope_text').notNull(), note: text('note').notNull(),
    createdBy: uuid('created_by').notNull().references(() => authUsers.id), createdAt: ts('created_at').notNull().defaultNow(), supersedesId: uuid('supersedes_id').unique(),
}, (t) => [unique().on(t.orgId, t.profileId, t.id), foreignKey({ columns: [t.orgId, t.profileId], foreignColumns: [adProfiles.orgId, adProfiles.id] }).onDelete('cascade'),
    foreignKey({ columns: [t.orgId, t.profileId, t.supersedesId], foreignColumns: [t.orgId, t.profileId, t.id] }).onDelete('cascade'), index('timeline_events_window').on(t.orgId, t.profileId, t.startOn)]);
export const timelineEvidenceSettings = pgTable('timeline_evidence_settings', {
    profileId: uuid('profile_id').primaryKey(), orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }), minDays: integer('min_days'), minClicks: numeric('min_clicks'),
}, (t) => [foreignKey({ columns: [t.orgId, t.profileId], foreignColumns: [adProfiles.orgId, adProfiles.id] }).onDelete('cascade')]);
