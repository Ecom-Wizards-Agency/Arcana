import { boolean, foreignKey, index, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { EffectiveBidObservation, ListingFieldObservation, ListingChange, CollectorReceipt } from '@wizard-ads/shared';
import { ts } from './columns.js';
import { adProfiles } from './tenancy.js';
const scopeColumns = () => ({ orgId: uuid('org_id').notNull(), profileId: uuid('profile_id').notNull(), marketplace: text('marketplace').notNull() });
export const ownEffectiveBidObservations = pgTable('own_effective_bid_observations', {
  id: text('id').primaryKey(), ...scopeColumns(), targetId: text('target_id').notNull(), observedAt: ts('observed_at').notNull(),
  collectedAt: ts('collected_at').notNull(), observation: jsonb('observation').$type<EffectiveBidObservation>().notNull(),
}, (t) => [foreignKey({ columns: [t.orgId,t.profileId], foreignColumns: [adProfiles.orgId,adProfiles.id] }).onDelete('cascade'),
  index('own_effective_bid_scope').on(t.orgId,t.profileId,t.targetId,t.observedAt)]);
export const ownListingObservations = pgTable('own_listing_observations', {
  id: text('id').primaryKey(), ...scopeColumns(), asin: text('asin').notNull(), field: text('field').notNull(),
  observedAt: ts('observed_at').notNull(), collectedAt: ts('collected_at').notNull(), observation: jsonb('observation').$type<ListingFieldObservation>().notNull(),
}, (t) => [foreignKey({ columns: [t.orgId,t.profileId], foreignColumns: [adProfiles.orgId,adProfiles.id] }).onDelete('cascade'), index('own_listing_scope').on(t.orgId,t.profileId,t.asin,t.field,t.observedAt)]);
export const ownListingChanges = pgTable('own_listing_changes', {
  id: text('id').primaryKey().references(() => ownListingObservations.id, { onDelete: 'cascade' }), ...scopeColumns(),
  asin: text('asin').notNull(), observedAt: ts('observed_at').notNull(), change: jsonb('change').$type<ListingChange>().notNull(),
}, (t) => [foreignKey({ columns: [t.orgId,t.profileId], foreignColumns: [adProfiles.orgId,adProfiles.id] }).onDelete('cascade'), index('own_listing_change_scope').on(t.orgId,t.profileId,t.observedAt)]);
export const collectorExportReferences = pgTable('collector_export_references', {
  id: uuid('id').primaryKey().defaultRandom(), ...scopeColumns(), family: text('family').notNull(), enabled: boolean('enabled').notNull().default(false), objectKey: text('object_key').notNull(),
}, (t) => [foreignKey({ columns: [t.orgId,t.profileId], foreignColumns: [adProfiles.orgId,adProfiles.id] }).onDelete('cascade'),
  uniqueIndex('collector_export_references_scope').on(t.orgId,t.profileId,t.id), uniqueIndex('collector_export_references_object').on(t.profileId,t.family,t.objectKey)]);
export const collectorImportReceipts = pgTable('collector_import_receipts', {
  id: text('id').primaryKey(), ...scopeColumns(), referenceId: uuid('reference_id').notNull(), fingerprint: text('fingerprint').notNull(),
  observedAt: ts('observed_at').notNull(), collectedAt: ts('collected_at').notNull(), receipt: jsonb('receipt').$type<CollectorReceipt>().notNull(),
}, (t) => [foreignKey({ columns: [t.orgId,t.profileId,t.referenceId], foreignColumns: [collectorExportReferences.orgId,collectorExportReferences.profileId,collectorExportReferences.id] }).onDelete('cascade'),
  uniqueIndex('collector_import_receipts_content').on(t.referenceId,t.fingerprint)]);
