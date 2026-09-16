/** Dated 2026-09-07 audit contracts. Synthetic validation is not provider verification. */
import { z } from 'zod';
import { Uuid } from './primitives.js';

export const CoreFeatureReportType = z.enum([
  'spAdvertisedProduct', 'spPurchasedProduct', 'sbPurchasedProduct', 'sdPurchasedProduct',
  'sbTargeting', 'sbSearchTerm', 'sbCampaignPlacement', 'sbAdGroup',
  'sdAdGroup', 'sdAdGroupMatchedTarget', 'sdTargeting', 'sdTargetingMatchedTarget',
  'sdAdvertisedProduct', 'sdCampaignsMatchedTarget',
  'spGrossAndInvalids', 'sbGrossAndInvalids', 'sdGrossAndInvalids',
  'spCampaignMetrics', 'spTargetMetrics', 'spQueryMetrics', 'spPlacementMetrics', 'sbCampaignMetrics', 'sdCampaignMetrics', 'sbAdMetrics',
]);
export type CoreFeatureReportType = z.infer<typeof CoreFeatureReportType>;
export const ReportAttributionGeneration = z.enum(['legacy', 'multi_touch_v1']);
export type ReportAttributionGeneration = z.infer<typeof ReportAttributionGeneration>;
const day = z.iso.date();
const identity = z.string().min(1).max(2048);
const count = z.number().int().nonnegative();
const delivery = ['impressions', 'clicks', 'cost'] as const;
const spConversions = ['purchases1d', 'purchases7d', 'purchases14d', 'purchases30d', 'sales1d', 'sales7d', 'sales14d', 'sales30d', 'unitsSoldClicks7d', 'unitsSoldClicks14d', 'unitsSoldClicks30d', 'purchasesSameSku7d', 'salesSameSku7d', 'unitsSoldSameSku7d', 'salesOtherSku7d', 'unitsSoldOtherSku7d'] as const;
const conversions = ['purchases', 'sales', 'unitsSold', 'purchasesClicks', 'salesClicks', 'unitsSoldClicks', 'newToBrandPurchases', 'newToBrandSales', 'newToBrandUnitsSold', 'newToBrandPurchasesClicks', 'newToBrandSalesClicks', 'newToBrandUnitsSoldClicks'] as const;
const engagement = ['addToCart', 'addToCartClicks', 'detailPageViews', 'detailPageViewsClicks', 'brandedSearches', 'brandedSearchesClicks'] as const;
const video = ['videoFirstQuartileViews', 'videoMidpointViews', 'videoThirdQuartileViews', 'videoCompleteViews', 'videoUnmutes', 'video5SecondViews', 'viewableImpressions'] as const;
const traffic = ['grossImpressions', 'invalidImpressions', 'grossClicks', 'invalidClicks'] as const;

export interface CoreReportFamilyDefinition {
  reportTypeId: string;
  product: 'SP' | 'SB' | 'SD';
  groupBy: string;
  additionalGroupBy?: readonly string[];
  grain: string;
  required: readonly string[];
  optional: readonly string[];
  metrics: readonly string[];
  defaultMetrics: readonly string[];
  maximumDateDifferenceDays: number;
  retentionDays: number;
  consumer: string;
}

const productDimensions = ['adGroupId', 'adId', 'advertisedAsin', 'advertisedSku'] as const;
const sbMetrics = [...delivery, ...conversions, ...engagement, ...video];
const purchasedSp = spConversions.filter((name) => !name.includes('SameSku'));
/** A finite contract catalog, not a registration of queue handlers. */
export const CORE_REPORT_FAMILIES: Readonly<Record<CoreFeatureReportType, CoreReportFamilyDefinition>> = {
  spCampaignMetrics: { reportTypeId: 'spCampaigns', product: 'SP', groupBy: 'campaign', grain: 'campaign_metrics', required: ['campaignId'], optional: ['budgetRuleId', 'budgetRuleName'], metrics: [...delivery, ...spConversions], defaultMetrics: [...delivery, 'salesSameSku7d', 'salesOtherSku7d'], maximumDateDifferenceDays: 31, retentionDays: 95, consumer: 'campaigns' },
  spTargetMetrics: { reportTypeId: 'spTargeting', product: 'SP', groupBy: 'targeting', grain: 'target_metrics', required: ['campaignId', 'adGroupId', 'keywordId'], optional: [], metrics: [...delivery, ...spConversions], defaultMetrics: [...delivery, 'salesSameSku7d', 'salesOtherSku7d'], maximumDateDifferenceDays: 31, retentionDays: 95, consumer: 'targets,target360' },
  spQueryMetrics: { reportTypeId: 'spSearchTerm', product: 'SP', groupBy: 'searchTerm', grain: 'query_metrics', required: ['campaignId', 'adGroupId', 'keywordId', 'searchTerm'], optional: [], metrics: [...delivery, ...spConversions], defaultMetrics: [...delivery, 'salesSameSku7d', 'salesOtherSku7d'], maximumDateDifferenceDays: 31, retentionDays: 65, consumer: 'search_terms' },
  spPlacementMetrics: { reportTypeId: 'spCampaigns', product: 'SP', groupBy: 'campaign', additionalGroupBy: ['campaignPlacement'], grain: 'placement_metrics', required: ['campaignId', 'placementClassification'], optional: [], metrics: [...delivery, ...spConversions], defaultMetrics: [...delivery, 'salesSameSku7d', 'salesOtherSku7d'], maximumDateDifferenceDays: 31, retentionDays: 95, consumer: 'placements' },
  sbCampaignMetrics: { reportTypeId: 'sbCampaigns', product: 'SB', groupBy: 'campaign', grain: 'campaign_metrics', required: ['campaignId'], optional: ['budgetRuleId', 'budgetRuleName'], metrics: sbMetrics, defaultMetrics: [...delivery, 'purchases', 'sales', 'unitsSold', 'newToBrandPurchases', 'newToBrandSales', 'videoCompleteViews', 'videoUnmutes'], maximumDateDifferenceDays: 31, retentionDays: 60, consumer: 'campaigns' },
  sdCampaignMetrics: { reportTypeId: 'sdCampaigns', product: 'SD', groupBy: 'campaign', grain: 'campaign_metrics', required: ['campaignId'], optional: ['budgetRuleId', 'budgetRuleName'], metrics: sbMetrics, defaultMetrics: [...delivery, 'purchases', 'sales', 'unitsSold', 'newToBrandPurchases', 'newToBrandSales', 'videoCompleteViews', 'videoUnmutes'], maximumDateDifferenceDays: 31, retentionDays: 65, consumer: 'campaigns' },
  sbAdMetrics: { reportTypeId: 'sbAds', product: 'SB', groupBy: 'ads', grain: 'sb_ad', required: ['campaignId', 'adGroupId', 'adId'], optional: [], metrics: sbMetrics, defaultMetrics: [...delivery, 'purchases', 'sales', 'unitsSold', 'newToBrandPurchases', 'newToBrandSales', 'videoCompleteViews', 'videoUnmutes'], maximumDateDifferenceDays: 31, retentionDays: 60, consumer: 'creatives' },

  spAdvertisedProduct: { reportTypeId: 'spAdvertisedProduct', product: 'SP', groupBy: 'advertiser', grain: 'advertised_product', required: ['campaignId', 'adGroupId', 'advertisedAsin'], optional: ['adId', 'advertisedSku'], metrics: [...delivery, ...spConversions], defaultMetrics: [...delivery, 'purchases7d', 'sales7d', 'unitsSoldClicks7d'], maximumDateDifferenceDays: 31, retentionDays: 95, consumer: 'products' },
  spPurchasedProduct: { reportTypeId: 'spPurchasedProduct', product: 'SP', groupBy: 'asin', grain: 'purchased_product', required: ['campaignId', 'adGroupId', 'purchasedAsin'], optional: ['adId', 'advertisedAsin', 'advertisedSku', 'keywordId', 'keyword', 'matchType', 'targeting'], metrics: purchasedSp, defaultMetrics: ['purchases7d', 'sales7d', 'unitsSoldClicks7d'], maximumDateDifferenceDays: 31, retentionDays: 95, consumer: 'products' },
  sbPurchasedProduct: { reportTypeId: 'sbPurchasedProduct', product: 'SB', groupBy: 'purchasedAsin', grain: 'purchased_product', required: ['campaignId', 'purchasedAsin'], optional: [...productDimensions, 'purchasedProductCategory'], metrics: conversions, defaultMetrics: ['purchases', 'sales', 'unitsSold'], maximumDateDifferenceDays: 731, retentionDays: 731, consumer: 'products' },
  sdPurchasedProduct: { reportTypeId: 'sdPurchasedProduct', product: 'SD', groupBy: 'asin', grain: 'purchased_product', required: ['campaignId', 'adGroupId', 'purchasedAsin'], optional: ['adId', 'advertisedAsin', 'advertisedSku', 'targetingId', 'targetingExpression'], metrics: conversions, defaultMetrics: ['purchases', 'sales', 'unitsSold'], maximumDateDifferenceDays: 31, retentionDays: 65, consumer: 'products' },
  sbTargeting: { reportTypeId: 'sbTargeting', product: 'SB', groupBy: 'targeting', grain: 'sb_target', required: ['campaignId', 'adGroupId', 'keywordId'], optional: ['keywordText', 'matchType', 'targeting'], metrics: [...sbMetrics, 'topOfSearchImpressionShare'], defaultMetrics: [...delivery, 'purchases', 'sales'], maximumDateDifferenceDays: 31, retentionDays: 60, consumer: 'targets' },
  sbSearchTerm: { reportTypeId: 'sbSearchTerm', product: 'SB', groupBy: 'searchTerm', grain: 'sb_search_term', required: ['campaignId', 'adGroupId', 'keywordId', 'searchTerm'], optional: ['keywordText', 'matchType'], metrics: [...delivery, ...conversions, ...engagement], defaultMetrics: [...delivery, 'purchases', 'sales'], maximumDateDifferenceDays: 31, retentionDays: 60, consumer: 'search_terms,query_intelligence' },
  sbCampaignPlacement: { reportTypeId: 'sbCampaignPlacement', product: 'SB', groupBy: 'campaign', grain: 'sb_placement', required: ['campaignId', 'placementClassification'], optional: [], metrics: sbMetrics, defaultMetrics: [...delivery, 'purchases', 'sales'], maximumDateDifferenceDays: 31, retentionDays: 60, consumer: 'placements' },
  sbAdGroup: { reportTypeId: 'sbAdGroup', product: 'SB', groupBy: 'adGroup', grain: 'ad_group', required: ['campaignId', 'adGroupId'], optional: [], metrics: sbMetrics, defaultMetrics: [...delivery, 'purchases', 'sales'], maximumDateDifferenceDays: 31, retentionDays: 60, consumer: 'ad_groups' },
  sdAdGroup: { reportTypeId: 'sdAdGroup', product: 'SD', groupBy: 'adGroup', grain: 'ad_group', required: ['campaignId', 'adGroupId'], optional: [], metrics: sbMetrics, defaultMetrics: [...delivery, 'purchases', 'sales'], maximumDateDifferenceDays: 31, retentionDays: 65, consumer: 'ad_groups' },
  sdAdGroupMatchedTarget: { reportTypeId: 'sdAdGroup', product: 'SD', groupBy: 'matchedTarget', grain: 'sd_ad_group_matched_target', required: ['campaignId', 'adGroupId', 'matchedTargetAsin'], optional: [], metrics: sbMetrics, defaultMetrics: [...delivery, 'purchases', 'sales'], maximumDateDifferenceDays: 31, retentionDays: 65, consumer: 'target360' },
  sdTargeting: { reportTypeId: 'sdTargeting', product: 'SD', groupBy: 'targeting', grain: 'sd_target', required: ['campaignId', 'adGroupId', 'targetingId'], optional: ['targetingExpression'], metrics: sbMetrics, defaultMetrics: [...delivery, 'purchases', 'sales'], maximumDateDifferenceDays: 31, retentionDays: 65, consumer: 'targets,target360' },
  sdTargetingMatchedTarget: { reportTypeId: 'sdTargeting', product: 'SD', groupBy: 'matchedTarget', grain: 'sd_target_matched_target', required: ['campaignId', 'adGroupId', 'targetingId', 'matchedTargetAsin'], optional: ['targetingExpression'], metrics: sbMetrics, defaultMetrics: [...delivery, 'purchases', 'sales'], maximumDateDifferenceDays: 31, retentionDays: 65, consumer: 'target360' },
  sdAdvertisedProduct: { reportTypeId: 'sdAdvertisedProduct', product: 'SD', groupBy: 'advertiser', grain: 'advertised_product', required: ['campaignId', 'adGroupId', 'advertisedAsin'], optional: ['adId', 'advertisedSku'], metrics: sbMetrics, defaultMetrics: [...delivery, 'purchases', 'sales'], maximumDateDifferenceDays: 31, retentionDays: 65, consumer: 'products' },
  sdCampaignsMatchedTarget: { reportTypeId: 'sdCampaigns', product: 'SD', groupBy: 'matchedTarget', grain: 'sd_campaign_matched_target', required: ['campaignId', 'matchedTargetAsin'], optional: [], metrics: sbMetrics, defaultMetrics: [...delivery, 'purchases', 'sales'], maximumDateDifferenceDays: 31, retentionDays: 65, consumer: 'campaigns,target360' },
  spGrossAndInvalids: { reportTypeId: 'spGrossAndInvalids', product: 'SP', groupBy: 'campaign', grain: 'traffic_quality', required: ['campaignId'], optional: [], metrics: traffic, defaultMetrics: traffic, maximumDateDifferenceDays: 365, retentionDays: 365, consumer: 'campaigns,target360' },
  sbGrossAndInvalids: { reportTypeId: 'sbGrossAndInvalids', product: 'SB', groupBy: 'campaign', grain: 'traffic_quality', required: ['campaignId'], optional: [], metrics: traffic, defaultMetrics: traffic, maximumDateDifferenceDays: 365, retentionDays: 365, consumer: 'campaigns,target360' },
  sdGrossAndInvalids: { reportTypeId: 'sdGrossAndInvalids', product: 'SD', groupBy: 'campaign', grain: 'traffic_quality', required: ['campaignId'], optional: [], metrics: traffic, defaultMetrics: traffic, maximumDateDifferenceDays: 365, retentionDays: 365, consumer: 'campaigns,target360' },
};

export const CoreReportConfiguration = z.strictObject({
  version: z.literal(1), family: CoreFeatureReportType,
  timeUnit: z.enum(['DAILY', 'SUMMARY']), format: z.literal('GZIP_JSON'),
  attributionGeneration: ReportAttributionGeneration,
  columns: z.array(identity).min(1).max(100),
}).superRefine((value, context) => {
  const spec = CORE_REPORT_FAMILIES[value.family];
  const dates = value.timeUnit === 'DAILY' ? ['date'] : ['startDate', 'endDate'];
  const allowed = new Set([...dates, ...spec.required, ...spec.optional, ...spec.metrics]);
  if (new Set(value.columns).size !== value.columns.length || value.columns.some((column) => !allowed.has(column))) context.addIssue({ code: 'custom', message: 'unsupported or duplicate report columns' });
  if (!value.columns.some((column) => spec.metrics.includes(column))) context.addIssue({ code: 'custom', message: 'report requires a measurement column' });
  if ([...dates, ...spec.required].some((column) => !value.columns.includes(column))) context.addIssue({ code: 'custom', message: 'required report identity column absent' });
});
export type CoreReportConfiguration = z.infer<typeof CoreReportConfiguration>;

export const CoreReportRow = z.strictObject({
  family: CoreFeatureReportType, periodStart: day, periodEnd: day,
  timeUnit: z.enum(['DAILY', 'SUMMARY']), attributionGeneration: ReportAttributionGeneration,
  dimensions: z.record(identity, identity.nullable()),
  metrics: z.record(identity, z.number().finite().nonnegative().nullable()),
  identityResolution: z.literal('reported_unresolved'),
}).superRefine((row, context) => {
  const spec = CORE_REPORT_FAMILIES[row.family];
  const keys = new Set([...spec.required, ...spec.optional]);
  if (spec.required.some((key) => !row.dimensions[key]) || Object.keys(row.dimensions).some((key) => !keys.has(key))) context.addIssue({ code: 'custom', message: 'invalid family identity dimensions' });
  if (Object.entries(row.metrics).some(([key, value]) => value !== null && (key === 'topOfSearchImpressionShare' ? value > 1 : key === 'cost' || key.toLowerCase().includes('sales') ? false : !Number.isSafeInteger(value)))) context.addIssue({ code: 'custom', path: ['metrics'], message: 'invalid count or ratio metric' });
  if (Object.keys(row.metrics).some((key) => !spec.metrics.includes(key))) context.addIssue({ code: 'custom', message: 'unsupported family metric' });
  if (row.periodStart > row.periodEnd || (row.timeUnit === 'DAILY' && row.periodStart !== row.periodEnd)) context.addIssue({ code: 'custom', message: 'invalid fact period' });
}).transform((row) => {
  const spec = CORE_REPORT_FAMILIES[row.family];
  return { ...row, dimensions: Object.fromEntries([...spec.required, ...spec.optional].map((key) => [key, row.dimensions[key] ?? null] as const)) };
});
export type CoreReportRow = z.infer<typeof CoreReportRow>;

/** Display text and budget context cannot split a target or campaign identity. */
export function coreReportIdentity(row: CoreReportRow): Record<string, string | null> {
  const spec = CORE_REPORT_FAMILIES[row.family];
  const keys = ['advertised_product', 'purchased_product'].includes(spec.grain) ? [...spec.required, ...spec.optional] : spec.required;
  return Object.fromEntries([...keys].sort().map((key) => [key, row.dimensions[key] ?? null] as const));
}


export const CoreReportRefusal = z.strictObject({ index: count, reason: z.enum(['invalid_row', 'invalid_dimension', 'invalid_metric', 'invalid_period', 'conflicting_duplicate']) });
export const CoreReportParseResult = z.strictObject({
  configuration: CoreReportConfiguration, sourceRows: count, parsedRows: count,
  duplicateRows: count, rows: z.array(CoreReportRow).max(100_000), refusals: z.array(CoreReportRefusal),
}).superRefine((value, context) => {
  if (value.sourceRows !== value.parsedRows + value.refusals.length || value.parsedRows !== value.rows.length + value.duplicateRows) context.addIssue({ code: 'custom', message: 'report row accounting mismatch' });
  if (value.rows.some((row) => row.family !== value.configuration.family || row.timeUnit !== value.configuration.timeUnit || row.attributionGeneration !== value.configuration.attributionGeneration || Object.keys(row.metrics).some((key) => !value.configuration.columns.includes(key)))) context.addIssue({ code: 'custom', message: 'fact configuration mismatch' });
});
export type CoreReportParseResult = z.infer<typeof CoreReportParseResult>;

export const CoreReportPromotion = z.strictObject({
  orgId: Uuid, profileId: Uuid, reportRequestId: Uuid, requestedAt: z.iso.datetime(),
  observedAt: z.iso.datetime(), startDate: day, endDate: day, parsed: CoreReportParseResult,
}).superRefine((input, context) => {
  const days = (Date.parse(input.endDate) - Date.parse(input.startDate)) / 86_400_000;
  if (days < 0 || days > CORE_REPORT_FAMILIES[input.parsed.configuration.family].maximumDateDifferenceDays || input.parsed.rows.some((row) => row.periodStart < input.startDate || row.periodEnd > input.endDate)) context.addIssue({ code: 'custom', message: 'invalid promotion period' });
});
export type CoreReportPromotion = z.infer<typeof CoreReportPromotion>;
export const CoreReportCapability = z.strictObject({
  orgId: Uuid, profileId: Uuid, family: CoreFeatureReportType,
  approvedConfigurations: z.array(CoreReportConfiguration).max(32).default([]),
  enabled: z.boolean().default(false), recoveryGateEvidence: identity.nullable(),
  status: z.enum(['unassessed', 'eligible', 'unsupported']).default('unassessed'),
  marketplace: identity, sbMultiAdGroupsEnabled: z.boolean().nullable(),
  multiTouchEvidence: identity.nullable(), observedAt: z.iso.datetime().nullable(),
});
export type CoreReportCapability = z.infer<typeof CoreReportCapability>;

export const CoreReportEvidence = z.strictObject({
  family: CoreFeatureReportType, grain: z.string(), variant: z.string().optional(),
  status: z.enum(['measured', 'partial', 'stale', 'unmeasured']),
  rowCount: count, truncated: z.boolean(), observedAt: z.iso.datetime().nullable(),
  rows: z.array(CoreReportRow),
});
export type CoreReportEvidence = z.infer<typeof CoreReportEvidence>;
