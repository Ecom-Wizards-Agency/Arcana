import { boolean, foreignKey, index, jsonb, pgTable, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { ProviderCollectionConfig, ProviderEvidenceRun, ProviderRecommendation } from '@wizard-ads/shared';
import { adProfiles } from './tenancy.js';
export const providerEvidenceConfigs = pgTable('provider_evidence_configs', {
  id: uuid('id').primaryKey(), orgId: uuid('org_id').notNull(), profileId: uuid('profile_id').notNull(), enabled: boolean('enabled').notNull().default(false), config: jsonb('config').$type<ProviderCollectionConfig>().notNull(),
}, (t) => [uniqueIndex('provider_configs_scope').on(t.orgId, t.profileId, t.id), foreignKey({ columns: [t.orgId, t.profileId], foreignColumns: [adProfiles.orgId, adProfiles.id] }).onDelete('cascade')]);
export const providerRecommendationRuns = pgTable('provider_recommendation_runs', {
  id: uuid('id').primaryKey(), orgId: uuid('org_id').notNull(), profileId: uuid('profile_id').notNull(), configId: uuid('config_id').notNull(), run: jsonb('run').$type<ProviderEvidenceRun>().notNull(),
}, (t) => [uniqueIndex('provider_runs_scope_identity').on(t.orgId, t.profileId, t.id), index('provider_recommendation_runs_scope').on(t.orgId, t.profileId, t.configId), foreignKey({ columns: [t.orgId, t.profileId, t.configId], foreignColumns: [providerEvidenceConfigs.orgId, providerEvidenceConfigs.profileId, providerEvidenceConfigs.id] }).onDelete('cascade')]);
export const providerRecommendations = pgTable('provider_recommendations', {
  id: uuid('id').primaryKey().defaultRandom(), orgId: uuid('org_id').notNull(), profileId: uuid('profile_id').notNull(), family: text('family').notNull(), namespace: text('namespace').notNull(), providerId: text('provider_id').notNull(), version: text('version').notNull(), evidence: jsonb('evidence').$type<ProviderRecommendation>().notNull(),
}, (t) => [uniqueIndex('provider_evidence_scope_identity').on(t.orgId, t.profileId, t.id), uniqueIndex('provider_evidence_version').on(t.orgId, t.profileId, t.family, t.namespace, t.providerId, t.version), index('provider_recommendations_scope').on(t.orgId, t.profileId, t.family), foreignKey({ columns: [t.orgId, t.profileId], foreignColumns: [adProfiles.orgId, adProfiles.id] }).onDelete('cascade')]);
export const providerRecommendationRunRows = pgTable('provider_recommendation_run_rows', {
  orgId: uuid('org_id').notNull(), profileId: uuid('profile_id').notNull(), runId: uuid('run_id').notNull(), evidenceId: uuid('evidence_id').notNull(),
}, (t) => [primaryKey({ columns: [t.runId, t.evidenceId] }), foreignKey({ columns: [t.orgId, t.profileId, t.runId], foreignColumns: [providerRecommendationRuns.orgId, providerRecommendationRuns.profileId, providerRecommendationRuns.id] }).onDelete('cascade'), foreignKey({ columns: [t.orgId, t.profileId, t.evidenceId], foreignColumns: [providerRecommendations.orgId, providerRecommendations.profileId, providerRecommendations.id] }).onDelete('cascade')]);
