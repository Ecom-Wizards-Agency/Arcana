/** Immutable API snapshots and accounting; Stream remains in its existing ledger. */
import { sql } from 'drizzle-orm';
import { check, foreignKey, index, jsonb, pgTable, primaryKey, text, unique, uuid } from 'drizzle-orm/pg-core';
import type { BudgetUsageConfig, BudgetUsageObservation, BudgetUsageRunCounts, BudgetUsageRunInput } from '@wizard-ads/shared';
import { ts } from './columns.js';
import { adProduct } from './enums.js';
import { adProfiles, orgs } from './tenancy.js';

export const budgetUsageSettings = pgTable('budget_usage_settings', {
  orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  profileId: uuid('profile_id').primaryKey(),
  config: jsonb('config').$type<BudgetUsageConfig>().notNull().default({ apiEnabled: false, streamEnabled: false, maxAgeSeconds: null, nearLimitPercent: null, allowFreshStreamFallback: false, maxCampaigns: 1000, pageSize: 100, cadenceMinutes: 60 }),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, (t) => [foreignKey({ columns: [t.orgId, t.profileId], foreignColumns: [adProfiles.orgId, adProfiles.id] }).onDelete('cascade')]);

export const budgetUsageRuns = pgTable('budget_usage_runs', {
  id: uuid('id').primaryKey(),
  orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  profileId: uuid('profile_id').notNull(),
  source: text('source').notNull(),
  receivedAt: ts('received_at').notNull(),
  input: jsonb('input').$type<BudgetUsageRunInput>().notNull(),
  counts: jsonb('counts').$type<BudgetUsageRunCounts>().notNull(),
}, (t) => [
  foreignKey({ columns: [t.orgId, t.profileId], foreignColumns: [adProfiles.orgId, adProfiles.id] }).onDelete('cascade'),
  unique('budget_usage_runs_scope_key').on(t.orgId, t.profileId, t.id),
  unique('budget_usage_runs_source_scope_key').on(t.orgId, t.profileId, t.id, t.source),
  index('budget_usage_runs_latest_idx').on(t.orgId, t.profileId, t.source, t.receivedAt),
  check('budget_usage_runs_source_check', sql`${t.source} in ('amazon_ads_api','amazon_marketing_stream')`),
]);

export const budgetUsageObservations = pgTable('budget_usage_observations', {
  orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  profileId: uuid('profile_id').notNull(),
  adProduct: adProduct('ad_product').notNull(),
  campaignId: text('campaign_id').notNull(),
  sourceIdentity: text('source_identity').notNull(),
  providerUpdatedAt: ts('provider_updated_at').notNull(),
  receivedAt: ts('received_at').notNull(),
  runId: uuid('run_id').notNull(),
  source: text('source').notNull().default('amazon_ads_api'),
  observation: jsonb('observation').$type<BudgetUsageObservation>().notNull(),
}, (t) => [
  primaryKey({ columns: [t.orgId, t.profileId, t.adProduct, t.campaignId, t.sourceIdentity] }),
  unique('budget_usage_observations_provider_time_key').on(t.orgId, t.profileId, t.adProduct, t.campaignId, t.providerUpdatedAt),
  foreignKey({ columns: [t.orgId, t.profileId], foreignColumns: [adProfiles.orgId, adProfiles.id] }).onDelete('cascade'),
  foreignKey({ columns: [t.orgId, t.profileId, t.runId, t.source], foreignColumns: [budgetUsageRuns.orgId, budgetUsageRuns.profileId, budgetUsageRuns.id, budgetUsageRuns.source] }).onDelete('cascade'),
  index('budget_usage_observations_latest_idx').on(t.orgId, t.profileId, t.adProduct, t.campaignId, t.providerUpdatedAt),
  check('budget_usage_observations_api_check', sql`${t.observation}->>'source' = 'amazon_ads_api'`),
]);
