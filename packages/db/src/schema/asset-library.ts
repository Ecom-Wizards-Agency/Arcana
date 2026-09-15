import { foreignKey, integer, jsonb, numeric, pgTable, primaryKey, text, unique, uuid } from 'drizzle-orm/pg-core';
import type { AssetLibraryObservation } from '@wizard-ads/shared/asset-library';
import { orgs, adProfiles } from './tenancy.js';
import { ts } from './columns.js';
export const assetLibrarySnapshots = pgTable('asset_library_snapshots', {
  id: uuid('id').primaryKey(), orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }), profileId: uuid('profile_id').notNull(),
  observedAt: ts('observed_at').notNull(), sourceRows: integer('source_rows').notNull(), persistedRows: integer('persisted_rows').notNull(),
}, (t) => [foreignKey({ columns: [t.orgId, t.profileId], foreignColumns: [adProfiles.orgId, adProfiles.id] }).onDelete('cascade'), unique().on(t.orgId,t.profileId,t.id)]);
export const assetLibraryAssets = pgTable('asset_library_assets', {
  orgId: uuid('org_id').notNull(), profileId: uuid('profile_id').notNull(), snapshotId: uuid('snapshot_id').notNull(),
  amazonAssetId: text('amazon_asset_id').notNull(), version: text('version').notNull(), kind: text('kind').notNull(), name: text('name'),
  durationSeconds: numeric('duration_seconds'), thumbnailUrl: text('thumbnail_url'), thumbnailExpiresAt: ts('thumbnail_expires_at'),
  usedInCampaignIds: text('used_in_campaign_ids').array().notNull(), observation: jsonb('observation').$type<AssetLibraryObservation>().notNull(), observedAt: ts('observed_at').notNull(),
}, (t) => [primaryKey({ columns: [t.orgId,t.profileId,t.snapshotId,t.amazonAssetId,t.version] }), foreignKey({ columns: [t.orgId,t.profileId,t.snapshotId], foreignColumns: [assetLibrarySnapshots.orgId,assetLibrarySnapshots.profileId,assetLibrarySnapshots.id] }).onDelete('cascade')]);
