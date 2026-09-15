import { check, foreignKey, index, pgTable, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { SponsoredPromptStatus } from '@wizard-ads/shared';
import { count, money, ts } from './columns.js';
import { adProfiles, authUsers, orgs } from './tenancy.js';

export const sponsoredPrompts = pgTable('sponsored_prompts', {
  id: uuid('id').primaryKey().defaultRandom(), orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  profileId: uuid('profile_id').notNull(), adProduct: text('ad_product').$type<'SP' | 'SB'>().notNull(),
  campaignId: text('campaign_id').notNull(), adGroupId: text('ad_group_id').notNull(), promptText: text('prompt_text').notNull(), normalizedPrompt: text('normalized_prompt').notNull(),
  firstSeenAt: ts('first_seen_at').notNull(), lastSeenAt: ts('last_seen_at').notNull(), currentStatus: text('current_status').$type<SponsoredPromptStatus>().notNull(),
}, (t) => [uniqueIndex('sponsored_prompts_tenant_key').on(t.orgId, t.profileId, t.id),
  uniqueIndex('sponsored_prompts_identity').on(t.profileId, t.campaignId, t.adGroupId, t.normalizedPrompt),
  foreignKey({ columns: [t.orgId, t.profileId], foreignColumns: [adProfiles.orgId, adProfiles.id] }).onDelete('cascade'),
  check('sponsored_prompts_status', sql`${t.currentStatus} in ('live','paused')`)]);

export const sponsoredPromptObservations = pgTable('sponsored_prompt_observations', {
  id: uuid('id').primaryKey().defaultRandom(), orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }),
  profileId: uuid('profile_id').notNull(), promptId: uuid('prompt_id').notNull(), observedAt: ts('observed_at').notNull(),
  status: text('status').$type<SponsoredPromptStatus>().notNull(), intervalStart: ts('interval_start').notNull(), intervalEnd: ts('interval_end').notNull(),
  spend: money('spend', 18, 4), clicks: count('clicks'), sales: money('sales', 18, 4), orders: count('orders'),
}, (t) => [uniqueIndex('sponsored_prompt_observations_identity').on(t.promptId, t.observedAt),
  index('sponsored_prompt_observations_scope').on(t.orgId, t.profileId, t.observedAt),
  foreignKey({ columns: [t.orgId, t.profileId, t.promptId], foreignColumns: [sponsoredPrompts.orgId, sponsoredPrompts.profileId, sponsoredPrompts.id] }).onDelete('cascade')]);

export const sponsoredPromptVisits = pgTable('sponsored_prompt_visits', {
  orgId: uuid('org_id').notNull().references(() => orgs.id, { onDelete: 'cascade' }), profileId: uuid('profile_id').notNull(),
  userId: uuid('user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }), lastVisitedAt: ts('last_visited_at').notNull(),
}, (t) => [primaryKey({ columns: [t.orgId, t.profileId, t.userId] }),
  foreignKey({ columns: [t.orgId, t.profileId], foreignColumns: [adProfiles.orgId, adProfiles.id] }).onDelete('cascade')]);
