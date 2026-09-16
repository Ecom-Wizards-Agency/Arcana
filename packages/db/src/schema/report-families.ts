import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, date, jsonb, timestamp, primaryKey } from 'drizzle-orm/pg-core';
import type { CoreReportRow } from '@wizard-ads/shared';

function familyFact(name: string) {
  return pgTable(name, {
    orgId: uuid('org_id').notNull(), profileId: uuid('profile_id').notNull(),
    date: date('date').notNull(), periodEnd: date('period_end').notNull(),
    family: text('family').notNull(), variant: text('variant').notNull(), adProduct: text('ad_product').notNull(),
    dimensions: jsonb('dimensions').$type<CoreReportRow['dimensions']>().notNull(),
    identityDimensions: jsonb('identity_dimensions').$type<CoreReportRow['dimensions']>().notNull(),
    identityHash: text('identity_hash').notNull().generatedAlwaysAs(sql`md5(identity_dimensions::text)`), rowData: jsonb('row_data').$type<CoreReportRow>().notNull(),
    reportRequestId: uuid('report_request_id'), source: text('source').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(), loadedAt: timestamp('loaded_at', { withTimezone: true }).notNull(),
  }, (t) => [primaryKey({ columns: [t.orgId,t.profileId,t.date,t.periodEnd,t.family,t.variant,t.identityHash] })]);
}

export const factAdvertisedProductDaily = familyFact('fact_advertised_product_daily');
export const factPurchasedProductDaily = familyFact('fact_purchased_product_daily');
export const factSbTargetDaily = familyFact('fact_sb_target_daily');
export const factSbSearchTermDaily = familyFact('fact_sb_search_term_daily');
export const factSbPlacementDaily = familyFact('fact_sb_placement_daily');
export const factAdGroupDaily = familyFact('fact_ad_group_daily');
export const factSdTargetDaily = familyFact('fact_sd_target_daily');
export const factSdMatchedTargetDaily = familyFact('fact_sd_matched_target_daily');
export const factTrafficQualityDaily = familyFact('fact_traffic_quality_daily');
export const factAdsReportPeriodic = familyFact('fact_ads_report_periodic');
