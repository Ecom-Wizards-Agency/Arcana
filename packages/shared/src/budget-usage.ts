import { z } from 'zod';
import { AdProduct, AmazonId, CurrencyCode, IsoDate, Uuid } from './primitives.js';

/** Provider read contracts shared by the HTTP client and collector. */
export const BudgetUsage = z.object({
  campaignId: AmazonId, budget: z.number().finite().nonnegative(),
  budgetUsagePercent: z.number().finite().nonnegative(),
  usageUpdatedTimestamp: z.iso.datetime({ offset: true }),
});
export type BudgetUsage = z.infer<typeof BudgetUsage>;
export const BudgetUsageFailure = z.object({ campaignId: AmazonId, code: z.string().nullable(), details: z.string().nullable() });
export type BudgetUsageFailure = z.infer<typeof BudgetUsageFailure>;
export const BudgetUsageResult = z.object({ usage: z.array(BudgetUsage), failures: z.array(BudgetUsageFailure), requested: z.number().int().nonnegative() });
export type BudgetUsageResult = z.infer<typeof BudgetUsageResult>;
export const BudgetUsageSource = z.enum(['amazon_ads_api', 'amazon_marketing_stream']);
export type BudgetUsageSource = z.infer<typeof BudgetUsageSource>;
export const BudgetUsageScope = z.object({ orgId: Uuid, profileId: Uuid });
export type BudgetUsageScope = z.infer<typeof BudgetUsageScope>;
export const BudgetUsageIdentity = z.object({ adProduct: AdProduct, campaignId: AmazonId });
export type BudgetUsageIdentity = z.infer<typeof BudgetUsageIdentity>;
export const BudgetUsagePeriod = z.object({ start: IsoDate, end: IsoDate }).refine((p) => p.start <= p.end);
export type BudgetUsagePeriod = z.infer<typeof BudgetUsagePeriod>;
export const BudgetUsageObservation = z.object({
  ...BudgetUsageScope.shape, ...BudgetUsageIdentity.shape,
  source: BudgetUsageSource, sourceIdentity: z.string().min(1),
  currency: CurrencyCode.nullable(), budgetAmount: z.number().finite().nonnegative().nullable(),
  budgetType: z.enum(['daily', 'lifetime']).nullable(), period: BudgetUsagePeriod.nullable(),
  usagePercent: z.number().finite().nonnegative().nullable(),
  providerUpdatedAt: z.iso.datetime({ offset: true }), receivedAt: z.iso.datetime({ offset: true }),
  completeness: z.enum(['complete', 'partial']),
});
export type BudgetUsageObservation = z.infer<typeof BudgetUsageObservation>;
/** No tenant doctrine or activation is supplied by an absent configuration. */
export const BudgetUsageConfig = z.object({
  apiEnabled: z.boolean().default(false), streamEnabled: z.boolean().default(false),
  maxAgeSeconds: z.number().int().positive().nullable().default(null),
  nearLimitPercent: z.number().finite().nonnegative().nullable().default(null),
  allowFreshStreamFallback: z.boolean().default(false),
  maxCampaigns: z.number().int().min(1).max(100000).default(1000),
  pageSize: z.number().int().min(1).max(1000).default(100),
  cadenceMinutes: z.number().int().min(1).max(10080).default(60),
});
export type BudgetUsageConfig = z.infer<typeof BudgetUsageConfig>;
export const BudgetUsageCampaign = z.object({
  ...BudgetUsageIdentity.shape, campaignName: z.string().nullable(),
  currency: CurrencyCode.nullable(), budgetType: z.enum(['daily', 'lifetime']).nullable(),
  startDate: IsoDate.nullable(), endDate: IsoDate.nullable(),
});
export type BudgetUsageCampaign = z.infer<typeof BudgetUsageCampaign>;
export const BudgetUsageRunCounts = z.object({
  selected: z.number().int().nonnegative(), requested: z.number().int().nonnegative(),
  returned: z.number().int().nonnegative(), failed: z.number().int().nonnegative(),
  sourceRows: z.number().int().nonnegative(), parsedRows: z.number().int().nonnegative(), refusedRows: z.number().int().nonnegative(),
  loadedRows: z.number().int().nonnegative(), existingRows: z.number().int().nonnegative(), verifiedLoadedRows: z.number().int().nonnegative(),
}).superRefine((c, ctx) => {
  if (c.selected !== c.requested || c.requested !== c.returned + c.failed || c.sourceRows !== c.parsedRows + c.refusedRows || c.loadedRows !== c.verifiedLoadedRows || c.existingRows > c.loadedRows) {
    ctx.addIssue({ code: 'custom', message: 'Budget usage counts do not reconcile' });
  }
});
export type BudgetUsageRunCounts = z.infer<typeof BudgetUsageRunCounts>;
export const BudgetUsageEvidence = z.object({
  ...BudgetUsageScope.shape, config: BudgetUsageConfig,
  totalCampaigns: z.number().int().nonnegative(),
  campaigns: z.array(BudgetUsageCampaign), observations: z.array(BudgetUsageObservation),
  sources: z.array(z.object({ source: BudgetUsageSource, enabled: z.boolean(), complete: z.boolean(), requested: z.number().int().nonnegative(), failed: z.number().int().nonnegative() })),
});
export type BudgetUsageEvidence = z.infer<typeof BudgetUsageEvidence>;
export const BudgetUsageAvailability = z.enum(['disabled', 'unavailable', 'measured', 'partial', 'stale']);
export type BudgetUsageAvailability = z.infer<typeof BudgetUsageAvailability>;
export const CampaignBudgetUsageRead = z.object({
  ...BudgetUsageIdentity.shape, campaignName: z.string().nullable(), availability: BudgetUsageAvailability,
  observation: BudgetUsageObservation.nullable(), nearLimit: z.boolean().nullable(), remainingAmount: z.number().finite().nullable(),
});
export type CampaignBudgetUsageRead = z.infer<typeof CampaignBudgetUsageRead>;
export const BudgetUsageRead = z.object({ availability: BudgetUsageAvailability, campaigns: z.array(CampaignBudgetUsageRead), measuredCampaigns: z.number().int().nonnegative(), totalCampaigns: z.number().int().nonnegative() });
export type BudgetUsageRead = z.infer<typeof BudgetUsageRead>;
export const PortfolioSpendEvidence = z.object({
  portfolioId: AmazonId, name: z.string().nullable(), currency: CurrencyCode.nullable(),
  budgetAmount: z.number().finite().nonnegative().nullable(), budgetPolicy: z.string().nullable(),
  period: BudgetUsagePeriod.nullable(), asOf: IsoDate,
  memberCampaigns: z.number().int().nonnegative(), expectedCampaignDays: z.number().int().nonnegative(), observedCampaignDays: z.number().int().nonnegative(),
  unassignedCampaigns: z.number().int().nonnegative(), spend: z.number().finite().nullable(),
  oldestLoadedAt: z.iso.datetime({ offset: true }).nullable(), membershipComplete: z.boolean(),
});
export type PortfolioSpendEvidence = z.infer<typeof PortfolioSpendEvidence>;
export const PortfolioPacingRead = z.object({
  evidence: PortfolioSpendEvidence, availability: BudgetUsageAvailability,
  budgetToDate: z.number().finite().nullable(), pace: z.number().finite().nullable(), remainingAmount: z.number().finite().nullable(),
});
export type PortfolioPacingRead = z.infer<typeof PortfolioPacingRead>;

export const BudgetUsageRunInput = z.object({
  scope: BudgetUsageScope, runId: Uuid, source: BudgetUsageSource,
  selected: z.array(BudgetUsageIdentity), observations: z.array(BudgetUsageObservation),
  failures: z.array(z.object({ ...BudgetUsageIdentity.shape, code: z.string().nullable(), details: z.string().nullable() })),
  receivedAt: z.iso.datetime({ offset: true }), populationComplete: z.boolean(),
});
export type BudgetUsageRunInput = z.infer<typeof BudgetUsageRunInput>;
export const BudgetUsageCampaignPage = z.object({ campaigns: z.array(BudgetUsageCampaign), nextCursor: z.string().nullable(), totalCampaigns: z.number().int().nonnegative() });
export type BudgetUsageCampaignPage = z.infer<typeof BudgetUsageCampaignPage>;
export const BudgetUsagePersistedRun = z.object({ input: BudgetUsageRunInput, counts: BudgetUsageRunCounts });
export type BudgetUsagePersistedRun = z.infer<typeof BudgetUsagePersistedRun>;
