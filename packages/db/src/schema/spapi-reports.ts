import { sql } from 'drizzle-orm';
import { uniqueIndex, boolean, date, integer, jsonb, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { ts } from './columns.js';
const scope = () => ({orgId:uuid('org_id').notNull(),profileId:uuid('profile_id').notNull(),family:text('family').notNull()});
export const spapiReportSources=pgTable('spapi_report_sources',{
  ...scope(),connectionId:uuid('connection_id').notNull(),enabled:boolean('enabled').notNull().default(false),
  scheduleEnabled:boolean('schedule_enabled').notNull().default(false),policyAccepted:boolean('policy_accepted').notNull().default(false),
  providerPolicy:jsonb('provider_policy'),
  restatementDays:integer('restatement_days').notNull().default(0),nextRunAt:ts('next_run_at').notNull().defaultNow(),
},t=>[primaryKey({columns:[t.orgId,t.profileId,t.family]})]);
export const spapiReportRuns=pgTable('spapi_report_runs',{
  ...scope(),requestId:text('request_id').notNull(),revision:integer('revision').notNull(),checkpoint:jsonb('checkpoint').notNull(),
},t=>[primaryKey({columns:[t.orgId,t.profileId,t.family,t.requestId]})]);
export const spapiReportReceipts=pgTable('spapi_report_receipts',{
  ...scope(),requestId:text('request_id').notNull(),sellingPartnerId:text('selling_partner_id').notNull(),marketplaceId:text('marketplace_id').notNull(),
  startDate:date('start_date').notNull(),endDate:date('end_date').notNull(),observedAt:ts('observed_at').notNull(),report:jsonb('report').notNull(),
},t=>[primaryKey({columns:[t.orgId,t.profileId,t.family,t.requestId]}),
  uniqueIndex('spapi_report_receipts_provider_document').on(t.orgId,t.sellingPartnerId,t.marketplaceId,t.family,sql`(${t.report}->>'reportId')`,sql`(${t.report}->>'documentId')`)]);
const columns=()=>({
  orgId:uuid('org_id').notNull(),sellingPartnerId:text('selling_partner_id').notNull(),marketplaceId:text('marketplace_id').notNull(),date:date('date').notNull(),
  rowKey:text('row_key').notNull(),profileId:uuid('profile_id').notNull(),connectionId:uuid('connection_id').notNull(),grain:text('grain').notNull(),
  observedAt:ts('observed_at').notNull(),reportRequestId:text('report_request_id').notNull(),payload:jsonb('payload').notNull(),
});
export const factRetailSalesTrafficDaily=pgTable('fact_retail_sales_traffic_daily',columns(),t=>[primaryKey({columns:[t.orgId,t.sellingPartnerId,t.marketplaceId,t.date,t.rowKey]})]);
export const factAbaSearchTermsPeriodic=pgTable('fact_aba_search_terms_periodic',columns(),t=>[primaryKey({columns:[t.orgId,t.sellingPartnerId,t.marketplaceId,t.date,t.rowKey]})]);
export const spapiListingObservations=pgTable('spapi_listing_observations',columns(),t=>[primaryKey({columns:[t.orgId,t.profileId,t.reportRequestId,t.rowKey]})]);
