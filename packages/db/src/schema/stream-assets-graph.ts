/** WP-313 evidence schema; migrations own RLS, immutable triggers and retention operations. */
import { sql } from 'drizzle-orm';
import { bigint, boolean, check, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import type { AssetModerationObservation, ProviderGraphAssociation, ProviderGraphObservation,
  StreamExtensionBinding, StreamExtensionEvent, StreamExtensionReceipt } from '@wizard-ads/shared';
import type { AssetLibraryObservation } from '@wizard-ads/shared/asset-library';
import { ts } from './columns.js';
import { adProfiles, orgs } from './tenancy.js';

export const marketingStreamExtensionBindings = pgTable('marketing_stream_extension_bindings', {
  orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  profileId: uuid('profile_id').notNull(), datasetId: text('dataset_id').notNull(),
  subscriptionId: text('subscription_id').notNull(), destinationArn: text('destination_arn').notNull(),
  enabled: boolean('enabled').notNull().default(false), confirmed: boolean('confirmed').notNull().default(false),
  capabilityVerified: boolean('capability_verified').notNull().default(false),
  binding: jsonb('binding').$type<StreamExtensionBinding>().notNull(),
}, t => [
  primaryKey({ columns: [t.profileId, t.datasetId, t.subscriptionId] }),
  foreignKey({ columns: [t.orgId, t.profileId], foreignColumns: [adProfiles.orgId, adProfiles.id] }).onDelete('cascade'),
  check('marketing_stream_extension_bindings_dataset_id_check', sql`${t.datasetId} in (
    'sponsored-ads-campaign-diagnostics-recommendations','sp-budget-recommendations',
    'ads-campaign-management-campaigns','ads-campaign-management-adgroups','ads-campaign-management-ads',
    'ads-campaign-management-targets','sb-clickstream','sb-rich-media')`),
]);

/** Infrastructure-only receipt: deliberately has no inferred tenant column. */
export const marketingStreamExtensionReceipts = pgTable('marketing_stream_extension_receipts', {
  orgId: uuid('org_id'), profileId: uuid('profile_id'), datasetId: text('dataset_id'),
  deliveryId: text('delivery_id').primaryKey(), bodyFingerprint: text('body_fingerprint').notNull(),
  receivedAt: ts('received_at').notNull(), receipt: jsonb('receipt').$type<StreamExtensionReceipt>().notNull(),
  deadLetteredAt: ts('dead_lettered_at'), expiresAt: ts('expires_at').notNull(),
}, t => [
  index('marketing_stream_extension_receipts_retention').on(t.expiresAt),
  check('marketing_stream_extension_receipts_check', sql`${t.expiresAt} > ${t.receivedAt} and ${t.expiresAt} <= ${t.receivedAt} + interval '95 days'`),
]);

export const marketingStreamExtensionEvents = pgTable('marketing_stream_extension_events', {
  orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  profileId: uuid('profile_id').notNull(), identity: text('identity').notNull(), datasetId: text('dataset_id').notNull(),
  entityKey: text('entity_key').notNull(), eventTime: ts('event_time').notNull(),
  revision: bigint('revision', { mode: 'number' }).notNull(), payloadFingerprint: text('payload_fingerprint').notNull(),
  event: jsonb('event').$type<StreamExtensionEvent>().notNull(), receivedAt: ts('received_at').notNull(),
  expiresAt: ts('expires_at').notNull(),
}, t => [
  primaryKey({ columns: [t.orgId, t.profileId, t.identity] }),
  foreignKey({ columns: [t.orgId, t.profileId], foreignColumns: [adProfiles.orgId, adProfiles.id] }).onDelete('cascade'),
  check('marketing_stream_extension_events_revision_check', sql`${t.revision} >= 0`),
  check('marketing_stream_extension_events_check', sql`${t.expiresAt} > ${t.receivedAt} and ${t.expiresAt} <= ${t.receivedAt} + interval '95 days'`),
  index('marketing_stream_extension_events_current').on(t.orgId, t.profileId, t.datasetId, t.entityKey, t.eventTime.desc(), t.revision.desc()),
  index('marketing_stream_extension_events_retention').on(t.expiresAt),
]);

export const marketingStreamExtensionProjections = pgTable('marketing_stream_extension_projections', {
  orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  profileId: uuid('profile_id').notNull(), identity: text('identity').notNull(),
  status: text('status').notNull().default('pending'), attempts: integer('attempts').notNull().default(0),
  retryAfter: ts('retry_after'), reason: text('reason'), lastAttemptKey: text('last_attempt_key'),
}, t => [
  primaryKey({ columns: [t.orgId, t.profileId, t.identity] }),
  foreignKey({ columns: [t.orgId, t.profileId, t.identity],
    foreignColumns: [marketingStreamExtensionEvents.orgId, marketingStreamExtensionEvents.profileId, marketingStreamExtensionEvents.identity] }).onDelete('cascade'),
  check('marketing_stream_extension_projections_attempts_check', sql`${t.attempts} between 0 and 8`),
  check('marketing_stream_extension_projections_status_check', sql`${t.status} in ('pending','projected','blocked','retrying')`),
  index('marketing_stream_extension_projection_retry').on(t.status, t.retryAfter),
]);

export const assetLibraryVersions = pgTable('asset_library_versions', {
  orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  profileId: uuid('profile_id').notNull(), assetId: text('asset_id').notNull(), version: text('version').notNull(),
  fingerprint: text('fingerprint').notNull(), observation: jsonb('observation').$type<AssetLibraryObservation>().notNull(),
  observedAt: ts('observed_at').notNull(),
}, t => [
  primaryKey({ columns: [t.orgId, t.profileId, t.assetId, t.version] }),
  foreignKey({ columns: [t.orgId, t.profileId], foreignColumns: [adProfiles.orgId, adProfiles.id] }).onDelete('cascade'),
]);

export const assetLibraryObservations = pgTable('asset_library_observations', {
  orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  profileId: uuid('profile_id').notNull(), identity: text('identity').notNull(),
  assetId: text('asset_id').notNull(), assetVersion: text('asset_version').notNull(),
  observation: jsonb('observation').$type<AssetLibraryObservation>().notNull(),
  observedAt: ts('observed_at').notNull(), expiresAt: ts('expires_at').notNull(),
}, t => [
  primaryKey({ columns: [t.orgId, t.profileId, t.identity] }),
  foreignKey({ columns: [t.orgId, t.profileId], foreignColumns: [adProfiles.orgId, adProfiles.id] }).onDelete('cascade'),
  foreignKey({ columns: [t.orgId, t.profileId, t.assetId, t.assetVersion],
    foreignColumns: [assetLibraryVersions.orgId, assetLibraryVersions.profileId, assetLibraryVersions.assetId, assetLibraryVersions.version] }).onDelete('cascade'),
  check('asset_library_observations_check', sql`${t.expiresAt} > ${t.observedAt} and ${t.expiresAt} <= ${t.observedAt} + interval '95 days'`),
  index('asset_library_observation_lookup').on(t.orgId, t.profileId, t.assetId, t.assetVersion, t.observedAt.desc()),
  index('asset_library_observation_retention').on(t.expiresAt),
]);

export const assetModerationObservations = pgTable('asset_moderation_observations', {
  orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  profileId: uuid('profile_id').notNull(), identity: text('identity').notNull(),
  assetId: text('asset_id'), assetVersion: text('asset_version'),
  observation: jsonb('observation').$type<AssetModerationObservation>().notNull(),
  observedAt: ts('observed_at').notNull(), expiresAt: ts('expires_at').notNull(),
}, t => [
  primaryKey({ columns: [t.orgId, t.profileId, t.identity] }),
  foreignKey({ columns: [t.orgId, t.profileId], foreignColumns: [adProfiles.orgId, adProfiles.id] }).onDelete('cascade'),
  foreignKey({ columns: [t.orgId, t.profileId, t.assetId, t.assetVersion],
    foreignColumns: [assetLibraryVersions.orgId, assetLibraryVersions.profileId, assetLibraryVersions.assetId, assetLibraryVersions.version] }).onDelete('cascade'),
  check('asset_moderation_observations_check', sql`(${t.assetId} is null) = (${t.assetVersion} is null)`),
  check('asset_moderation_observations_check1', sql`${t.expiresAt} > ${t.observedAt} and ${t.expiresAt} <= ${t.observedAt} + interval '95 days'`),
  index('asset_moderation_lookup').on(t.orgId, t.profileId, t.assetId, t.assetVersion, t.observedAt.desc()),
  index('asset_moderation_retention').on(t.expiresAt),
]);

export const providerGraphObservations = pgTable('provider_graph_observations', {
  orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  profileId: uuid('profile_id').notNull(), identity: text('identity').notNull(), entityKey: text('entity_key').notNull(),
  observation: jsonb('observation').$type<ProviderGraphObservation>().notNull(),
  sourceEventAt: ts('source_event_at').notNull(), observedAt: ts('observed_at').notNull(), expiresAt: ts('expires_at').notNull(),
}, t => [
  primaryKey({ columns: [t.orgId, t.profileId, t.identity] }),
  foreignKey({ columns: [t.orgId, t.profileId], foreignColumns: [adProfiles.orgId, adProfiles.id] }).onDelete('cascade'),
  check('provider_graph_observations_check', sql`${t.expiresAt} > ${t.observedAt} and ${t.expiresAt} <= ${t.observedAt} + interval '95 days'`),
  index('provider_graph_current').on(t.orgId, t.profileId, t.entityKey, t.sourceEventAt.desc()),
  index('provider_graph_retention').on(t.expiresAt),
]);

export const providerEntityAssociations = pgTable('provider_entity_associations', {
  orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  profileId: uuid('profile_id').notNull(), identity: text('identity').notNull(),
  association: jsonb('association').$type<ProviderGraphAssociation>().notNull(),
  resolution: text('resolution').notNull().default('unresolved'), observedAt: ts('observed_at').notNull(), expiresAt: ts('expires_at').notNull(),
}, t => [
  primaryKey({ columns: [t.orgId, t.profileId, t.identity] }),
  foreignKey({ columns: [t.orgId, t.profileId], foreignColumns: [adProfiles.orgId, adProfiles.id] }).onDelete('cascade'),
  check('provider_entity_associations_resolution_check', sql`${t.resolution} in ('unresolved','resolved','tombstoned','conflict')`),
  check('provider_entity_associations_check', sql`${t.expiresAt} > ${t.observedAt} and ${t.expiresAt} <= ${t.observedAt} + interval '95 days'`),
  index('provider_association_resolution').on(t.orgId, t.profileId, t.resolution),
  index('provider_association_retention').on(t.expiresAt),
]);

export const assetRegistrationAuthorities = pgTable('asset_registration_authorities', {
  id: uuid('id').primaryKey(), orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  profileId: uuid('profile_id').notNull(), actorId: uuid('actor_id').notNull(),
  enabled: boolean('enabled').notNull().default(false), request: jsonb('request').notNull(), expiresAt: ts('expires_at').notNull(),
}, t => [foreignKey({ columns: [t.orgId,t.profileId], foreignColumns: [adProfiles.orgId,adProfiles.id] }).onDelete('cascade')]);
export const assetRegistrationIntents = pgTable('asset_registration_intents', {
  id: uuid('id').primaryKey(), orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  profileId: uuid('profile_id').notNull(), actorId: uuid('actor_id').notNull(),
  authorityId: uuid('authority_id').notNull().unique().references(() => assetRegistrationAuthorities.id),
  request: jsonb('request').notNull(), status: text('status').notNull().default('admitted'), outcome: jsonb('outcome'),
  attemptedAt: ts('attempted_at'), observedAt: ts('observed_at'), searchJobId: uuid('search_job_id').unique(),
  createdAt: ts('created_at').notNull().defaultNow(),
}, t => [foreignKey({ columns: [t.orgId,t.profileId], foreignColumns: [adProfiles.orgId,adProfiles.id] }).onDelete('cascade'),
  index('asset_registration_reconciliation').on(t.status,t.attemptedAt),
  check('asset_registration_intents_status_check',sql`${t.status} in ('admitted','attempting','uncertain','accepted','refused')`)]);
