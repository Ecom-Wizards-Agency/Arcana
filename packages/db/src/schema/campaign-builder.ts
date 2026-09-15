import { foreignKey, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import type { CampaignCreationPlan, CampaignBuilderRecipe, CampaignBuilderValidation, CampaignDraft, NamingStrategy } from '@wizard-ads/shared';
import { ts } from './columns.js';
import { orgs, adProfiles, authUsers } from './tenancy.js';

export const campaignDrafts = pgTable('campaign_drafts', {
  id: uuid('id').primaryKey().defaultRandom(), orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  profileId: uuid('profile_id').notNull(), createdBy: uuid('created_by').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
  status: text('status').$type<CampaignDraft['status']>().notNull().default('draft'), revision: integer('revision').notNull().default(1),
  plan: jsonb('plan').$type<CampaignCreationPlan>().notNull(), recipe: jsonb('recipe').$type<CampaignBuilderRecipe>().notNull(),
  rationale: jsonb('rationale').$type<CampaignDraft['rationale']>().notNull(), validation: jsonb('validation').$type<CampaignBuilderValidation>(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, (t) => [foreignKey({ columns: [t.orgId, t.profileId], foreignColumns: [adProfiles.orgId, adProfiles.id] }).onDelete('cascade')]);
export const namingPresets = pgTable('naming_presets', {
  id: uuid('id').primaryKey().defaultRandom(), orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  name: text('name').notNull(), naming: jsonb('naming').$type<NamingStrategy>().notNull(), createdBy: uuid('created_by').notNull().references(() => authUsers.id),
});
export const keywordSets = pgTable('keyword_sets', {
  id: uuid('id').primaryKey().defaultRandom(), orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  profileId: uuid('profile_id').notNull(), name: text('name').notNull(), keywords: jsonb('keywords').$type<string[]>().notNull(),
}, (t) => [foreignKey({ columns: [t.orgId, t.profileId], foreignColumns: [adProfiles.orgId, adProfiles.id] }).onDelete('cascade')]);
