/** Typed storage mirror; controlled SQL is the only ordinary insertion path. */
import { sql } from 'drizzle-orm';
import { check, foreignKey, jsonb, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { ts } from './columns.js';
import { adProfiles } from './tenancy.js';

export const campaignCreationPreviews = pgTable('campaign_creation_previews', {
  orgId: uuid('org_id').notNull(), profileId: uuid('profile_id').notNull(), planId: uuid('plan_id').notNull(),
  artifactText: text('artifact_text').notNull(),
  // The storage RPC does not prove shared payload semantics. Readers must validate this unknown JSON.
  artifact: jsonb('artifact').$type<unknown>().notNull(), artifactSha256: text('artifact_sha256').notNull(),
  recordedBy: uuid('recorded_by').notNull(), recordedAt: ts('recorded_at').notNull().default(sql`clock_timestamp()`),
}, (table) => [
  primaryKey({ columns: [table.orgId, table.profileId, table.planId] }),
  foreignKey({ name: 'campaign_creation_previews_profile_fkey', columns: [table.orgId, table.profileId],
    foreignColumns: [adProfiles.orgId, adProfiles.id] }).onDelete('cascade'),
  check('campaign_creation_previews_artifact_agrees', sql`
    ${table.artifactText}::jsonb = ${table.artifact} and jsonb_typeof(${table.artifact}) = 'object'
    and (${table.artifact} ->> 'orgId')::uuid = ${table.orgId}
    and (${table.artifact} ->> 'profileId')::uuid = ${table.profileId}
    and (${table.artifact} ->> 'id')::uuid = ${table.planId}
    and ${table.artifact} ?& array['orgId','profileId','id']
    and ${table.artifact} -> 'orgId' <> 'null'::jsonb
    and ${table.artifact} -> 'profileId' <> 'null'::jsonb
    and ${table.artifact} -> 'id' <> 'null'::jsonb`),
  check('campaign_creation_previews_byte_digest', sql`
    ${table.artifactSha256} = encode(sha256(convert_to(${table.artifactText}, 'UTF8')), 'hex')`),
]);
