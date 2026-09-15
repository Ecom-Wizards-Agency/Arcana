import { foreignKey, jsonb, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { ts } from './columns.js';
import { entityType } from './enums.js';
import { adProfiles, orgs } from './tenancy.js';

/** Actual mirror observations, including syncs which produced no change. */
export const creativeEntityObservations = pgTable('creative_entity_observations', {
  orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  profileId: uuid('profile_id').notNull(), entityType: entityType('entity_type').notNull(),
  amazonId: text('amazon_id').notNull(), observedAt: ts('observed_at').notNull(),
  observationField: text('observation_field').notNull(), snapshot: jsonb('snapshot').notNull(),
}, (t) => [
  primaryKey({ columns: [t.profileId, t.entityType, t.amazonId, t.observedAt, t.observationField] }),
  foreignKey({ columns: [t.orgId, t.profileId], foreignColumns: [adProfiles.orgId, adProfiles.id] }).onDelete('cascade'),
]);
