import { sql } from 'drizzle-orm';
import { foreignKey, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { orgs, adProfiles, authUsers } from './tenancy.js';
import { ts } from './columns.js';

export const targetTranslations = pgTable('target_translations', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  profileId: uuid('profile_id').notNull(),
  originalText: text('original_text').notNull(),
  originalHash: text('original_hash').generatedAlwaysAs(sql`app.translation_text_hash(original_text)`),
  language: text('language').notNull(), status: text('status').notNull().default('waiting'),
  translatedText: text('translated_text'), reason: text('reason'),
  providerId: text('provider_id').notNull().default('not-configured'), requestId: uuid('request_id').notNull(),
  requestedBy: uuid('requested_by').notNull().references(() => authUsers.id),
  requestedAt: ts('requested_at').notNull().defaultNow(), completedAt: ts('completed_at'),
}, (t) => [
  foreignKey({ columns: [t.orgId, t.profileId], foreignColumns: [adProfiles.orgId, adProfiles.id] }).onDelete('cascade'),
  unique().on(t.orgId, t.profileId, t.originalHash, t.language),
]);
