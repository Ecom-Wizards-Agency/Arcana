/** Contracts for authoritative ad-to-creative-to-asset attribution. */
import { z } from 'zod';
import { AssetEligibilityEvidence, AssetModerationObservation } from './asset-evidence.js';
import { AssetLibraryObservation } from './asset-library.js';
import { AdProduct, AmazonId, IsoDate, Placement, Uuid } from './primitives.js';
import { TimelineDaily, TimelineEvent } from './timeline-events.js';
import { CampaignCreationAmazonModerationStatus } from './campaign-creation.js';
import { ProductMetadataSnapshot } from './ads-catalogue.js';

const count = z.number().int().nonnegative();
const money = z.number().nonnegative();

export const CreativeAttributionState = z.enum([
  'mapped',
  'legacy',
  'unsupported',
  'ambiguous',
  'unmapped',
]);
export type CreativeAttributionState = z.infer<typeof CreativeAttributionState>;

/**
 * A mapping observed on the current Sponsored Brands ad listing. This is
 * deliberately not named "historical": Amazon has not proved that a current
 * creative snapshot was valid on an earlier report date.
 */
export const CreativeMappingProvenance = z.enum(['current_sb_ad_snapshot']);
export type CreativeMappingProvenance = z.infer<typeof CreativeMappingProvenance>;

export const CreativeSyncSnapshotStatus = z.enum([
  'mapping_only',
  'report_pending',
  'completed',
  'blocked',
]);
export type CreativeSyncSnapshotStatus = z.infer<typeof CreativeSyncSnapshotStatus>;

/** Amazon Asset ID is the identity. A nullable content hash is never a key. */
export const CreativeAsset = z.object({
  profileId: Uuid,
  assetId: AmazonId,
  name: z.string().nullable(),
  assetType: z.string().min(1),
  contentHash: z.string().min(1).nullable(),
  thumbnailUrl: z.url().nullable(),
  amazonCreatedAt: z.iso.datetime().nullable().optional(),
  amazonUpdatedAt: z.iso.datetime().nullable().optional(),
});
export type CreativeAsset = z.infer<typeof CreativeAsset>;

/** Explicit placement mapping; an ad-group result is never assigned to one asset. */
export const AdCreativeAssetMapping = z.object({
  profileId: Uuid,
  adProduct: AdProduct,
  campaignId: AmazonId,
  adGroupId: AmazonId,
  adId: AmazonId,
  creativeId: AmazonId.nullable(),
  creativeVersion: z.string().min(1).nullable().default(null),
  assetId: AmazonId.nullable(),
  placement: Placement.nullable(),
  attributionState: CreativeAttributionState,
  mappingProvenance: CreativeMappingProvenance.nullable().default(null),
  creativeSyncSnapshotId: Uuid.nullable().default(null),
  observedAt: z.iso.datetime(),
});
export type AdCreativeAssetMapping = z.infer<typeof AdCreativeAssetMapping>;

export const CreativeDailyFact = z.object({
  profileId: Uuid,
  date: IsoDate,
  adProduct: AdProduct,
  campaignId: AmazonId,
  adGroupId: AmazonId,
  adId: AmazonId,
  creativeId: AmazonId.nullable(),
  creativeVersion: z.string().min(1).nullable().default(null),
  assetId: AmazonId.nullable(),
  placement: Placement.nullable(),
  attributionState: CreativeAttributionState,
  mappingProvenance: CreativeMappingProvenance.nullable().default(null),
  creativeSyncSnapshotId: Uuid.nullable().default(null),
  impressions: count,
  clicks: count,
  cost: money,
  purchases: count,
  sales: money,
  videoFirstQuartileViews: count.nullable(),
  videoMidpointViews: count.nullable(),
  videoThirdQuartileViews: count.nullable(),
  videoCompleteViews: count.nullable(),
});
export type CreativeDailyFact = z.infer<typeof CreativeDailyFact>;

/** Count reconciliation emitted by every creative ingestion batch. */
export const CreativeIngestionCounts = z.object({
  sourceAssets: count,
  parsedRows: count,
  mappedPlacements: count,
  unsupportedRows: count,
  refusedRows: count,
  upserts: count,
});
export type CreativeIngestionCounts = z.infer<typeof CreativeIngestionCounts>;

/**
 * Count-only evidence for one current SB ad/asset observation. Every parsed ad
 * belongs to exactly one coverage state; legacy rows without an ad ID stay in
 * the counts and never receive a fabricated identity.
 */
export const CreativeSyncSnapshot = z.object({
  id: Uuid,
  profileId: Uuid,
  startDate: IsoDate,
  endDate: IsoDate,
  observedAt: z.iso.datetime(),
  mappingProvenance: CreativeMappingProvenance,
  historicalValidity: z.literal('unproven_current_snapshot'),
  status: CreativeSyncSnapshotStatus,
  paginationComplete: z.boolean(),
  factPromotionAllowed: z.boolean(),
  sourceAssets: count,
  parsedAssets: count,
  sourceAds: count,
  parsedAds: count,
  mapped: count,
  legacy: count,
  unsupported: count,
  ambiguous: count,
  unmapped: count,
  reportSourceRows: count.nullable().default(null),
  reportParsedRows: count.nullable().default(null),
  reportRefusedRows: count.nullable().default(null),
  mappedFactRows: count,
  unpromotedReportRows: count,
}).superRefine((snapshot, context) => {
  const coverage = snapshot.mapped + snapshot.legacy + snapshot.unsupported
    + snapshot.ambiguous + snapshot.unmapped;
  if (coverage !== snapshot.parsedAds) {
    context.addIssue({
      code: 'custom',
      path: ['parsedAds'],
      message: `parsedAds ${snapshot.parsedAds} does not equal ${coverage} classified ads`,
    });
  }
  if (snapshot.parsedAssets > snapshot.sourceAssets || snapshot.parsedAds > snapshot.sourceAds) {
    context.addIssue({ code: 'custom', message: 'parsed counts cannot exceed source counts' });
  }
  if (
    snapshot.reportSourceRows !== null &&
    snapshot.reportParsedRows !== null &&
    snapshot.reportRefusedRows !== null &&
    snapshot.reportSourceRows !== snapshot.reportParsedRows + snapshot.reportRefusedRows
  ) {
    context.addIssue({ code: 'custom', message: 'report source counts do not reconcile' });
  }
  const reportCounts = [
    snapshot.reportSourceRows,
    snapshot.reportParsedRows,
    snapshot.reportRefusedRows,
  ];
  if (reportCounts.some((value) => value === null) && reportCounts.some((value) => value !== null)) {
    context.addIssue({ code: 'custom', message: 'report counts must be all present or all absent' });
  }
  if (
    reportCounts.every((value) => value === null) &&
    (snapshot.mappedFactRows !== 0 || snapshot.unpromotedReportRows !== 0)
  ) {
    context.addIssue({ code: 'custom', message: 'promotion counts require report counts' });
  }
  if (
    snapshot.reportParsedRows !== null &&
    snapshot.mappedFactRows + snapshot.unpromotedReportRows !== snapshot.reportParsedRows
  ) {
    context.addIssue({ code: 'custom', message: 'report promotion counts do not reconcile' });
  }
});
export type CreativeSyncSnapshot = z.infer<typeof CreativeSyncSnapshot>;

/** Read-side contracts keep the exact ad grain available for attribution disclosure. */
export const CreativeKeywordProvenance = z.enum(['synced', 'from_campaign_name', 'unresolved']);
export type CreativeKeywordProvenance = z.infer<typeof CreativeKeywordProvenance>;
export const CreativePerformanceDrilldown = z.object({
  keywordText: z.string().nullable(), keywordProvenance: CreativeKeywordProvenance,
  campaignId: z.string(), adGroupId: z.string(), adId: z.string(), creativeId: z.string().nullable(),
  creativeVersion: z.string().nullable(), mappingProvenance: CreativeMappingProvenance.nullable(), placement: Placement.nullable(),
  impressions: count, clicks: count, cost: money, purchases: count, sales: money,
  videoFirstQuartileViews: count.nullable(), videoMidpointViews: count.nullable(),
  videoThirdQuartileViews: count.nullable(), videoCompleteViews: count.nullable(),
}).refine((row) => row.keywordProvenance !== 'unresolved' || row.keywordText === null,
  { message: 'An unresolved keyword must remain blank', path: ['keywordText'] });
export type CreativePerformanceDrilldown = z.infer<typeof CreativePerformanceDrilldown>;
export const CreativePerformanceAsset = z.object({
  assetId: z.string().nullable(), attributionState: CreativeAttributionState,
  name: z.string().nullable(), assetType: z.string().nullable(), thumbnailUrl: z.string().nullable(),
  campaignTypes: z.array(z.string()), mappingProvenances: z.array(CreativeMappingProvenance),
  campaignCount: count, adGroupCount: count, adCount: count, placementCount: count,
  impressions: count, clicks: count, ctr: z.number().nonnegative().nullable(), cost: money, purchases: count, sales: money,
  acos: z.number().nonnegative().nullable(), roas: z.number().nonnegative().nullable(),
  videoFirstQuartileViews: count.nullable(), videoMidpointViews: count.nullable(),
  videoThirdQuartileViews: count.nullable(), videoCompleteViews: count.nullable(),
  drilldown: z.array(CreativePerformanceDrilldown),
});
export type CreativePerformanceAsset = z.infer<typeof CreativePerformanceAsset>;
export const CreativeChangeCertainty = z.object({
  kind: z.enum(['exact', 'window', 'first']),
  from: z.iso.datetime().nullable(), to: z.iso.datetime(), widthDays: count.nullable(),
}).superRefine((value, context) => {
  if (value.from !== null && value.from > value.to) context.addIssue({ code: 'custom', message: 'Observation order is reversed' });
  if (value.kind === 'exact' && (value.from === null || value.widthDays === null || value.widthDays > 1))
    context.addIssue({ code: 'custom', message: 'Exact certainty needs consecutive daily observations' });
  if (value.kind === 'first' && (value.from !== null || value.widthDays !== null))
    context.addIssue({ code: 'custom', message: 'First observation has no earlier boundary' });
});
export type CreativeChangeCertainty = z.infer<typeof CreativeChangeCertainty>;
export const CreativeWorkspaceAsset = z.object({
  assetId: z.string().nullable(), attributionState: CreativeAttributionState,
  name: z.string().nullable(), assetType: z.string().nullable(), thumbnailUrl: z.string().nullable(),
  firstSeenAt: z.iso.datetime().nullable(), durationSeconds: z.number().positive().nullable(),
  width: count.nullable(), height: count.nullable(), advertisedAsin: z.string().nullable(),
  moderation: CampaignCreationAmazonModerationStatus.nullable(),
  assetLibrary: z.array(AssetLibraryObservation).optional(),
  eligibility: z.array(AssetEligibilityEvidence).optional(),
  assetLibraryEvidence: z.array(z.object({ observation: AssetLibraryObservation, expiresAt: z.iso.datetime() })).optional(),
  moderationEvidence: z.array(z.object({ observation: AssetModerationObservation, expiresAt: z.iso.datetime() })).optional(),
  campaignIds: z.array(z.string()), adGroupIds: z.array(z.string()),
  /** Campaigns from creative_placements overlapping the selected window only. */
  placementCampaignIds: z.array(z.string()),
  performance: CreativePerformanceAsset.nullable(),
});
export type CreativeWorkspaceAsset = z.infer<typeof CreativeWorkspaceAsset>;
export const CreativeWorkspaceCampaign = z.object({
  campaignId: z.string(), name: z.string().nullable(), keywordText: z.string().nullable(),
  keywordProvenance: CreativeKeywordProvenance, keywordCount: count.nullable(),
  adGroups: z.array(z.object({ adGroupId: z.string(), name: z.string().nullable(), assetIds: z.array(z.string()), unmappedCount: count })),
  modifiers: z.object({ topOfSearch: z.number().nullable(), restOfSearch: z.number().nullable(), productPages: z.number().nullable() }),
}).refine((row) => row.keywordProvenance !== 'unresolved' || row.keywordText === null,
  { message: 'An unresolved keyword must remain blank', path: ['keywordText'] });
export type CreativeWorkspaceCampaign = z.infer<typeof CreativeWorkspaceCampaign>;
export const CreativeWorkspacePlacement = z.object({
  campaignId: z.string(), placement: Placement, impressions: count, clicks: count,
  cost: money, sales: money, purchases: count, modifier: z.number().nullable(),
});
export type CreativeWorkspacePlacement = z.infer<typeof CreativeWorkspacePlacement>;
export const CreativeWorkspaceChange = z.object({
  id: z.string(), assetIds: z.array(z.string()), campaignId: z.string().nullable(), adGroupId: z.string().nullable(),
  kind: z.enum(['Bid', 'Placement', 'Creative', 'Listing', 'Promotion']), field: z.string(), oldValue: z.unknown(), newValue: z.unknown(),
  observedAt: z.iso.datetime(), certainty: CreativeChangeCertainty,
  scope: z.string(), effect: z.enum(['direct', 'whole campaign']),
});
export type CreativeWorkspaceChange = z.infer<typeof CreativeWorkspaceChange>;
export const CreativeListingObservation = z.object({
  id: z.string(), asin: z.string(), marketplaceId: z.string(), previous: ProductMetadataSnapshot,
  current: ProductMetadataSnapshot,
});
export type CreativeListingObservation = z.infer<typeof CreativeListingObservation>;
export const CreativeWorkspace = z.object({
  listingCoverage: z.object({ measuredFields: count, staleFields: count }).optional(),
  assets: z.array(CreativeWorkspaceAsset), campaigns: z.array(CreativeWorkspaceCampaign),
  placements: z.array(CreativeWorkspacePlacement), changes: z.array(CreativeWorkspaceChange),
  listingChanges: z.array(CreativeListingObservation),
  history: z.array(z.lazy(() => TimelineDaily)), events: z.array(z.lazy(() => TimelineEvent)),
  minClicks: z.number().nonnegative().nullable(), targetAcos: z.number().positive().nullable(),
});
export type CreativeWorkspace = z.infer<typeof CreativeWorkspace>;

export const CreativeCampaignPerformance = z.object({
  campaignId: z.string(), impressions: count, clicks: count, cost: money, purchases: count, sales: money,
  ctr: z.number().nullable(), cvr: z.number().nullable(), cpc: z.number().nullable(), acos: z.number().nullable(),
  share: z.number().nullable(), videoCompleteViews: count.nullable(),
});
export type CreativeCampaignPerformance = z.infer<typeof CreativeCampaignPerformance>;
export const CreativeTestRow = z.object({
  assetId: z.string().nullable(), adGroupId: z.string(), name: z.string().nullable(), adGroupName: z.string().nullable(),
  thumbnailUrl: z.string().nullable(), performance: CreativeCampaignPerformance.nullable(),
  measured: z.boolean(), unmeasuredReason: z.string().nullable(), deliveryShare: z.number().nullable(),
});
export type CreativeTestRow = z.infer<typeof CreativeTestRow>;
export const CreativeMetricVerdict = z.object({
  metric: z.enum(['ctr', 'cvr']), spread: z.number().nonnegative().nullable(), floor: z.number().nonnegative().nullable(),
  separates: z.boolean().nullable(), reason: z.string().nullable(), observedFortnights: count, requiredFortnights: count,
});
export type CreativeMetricVerdict = z.infer<typeof CreativeMetricVerdict>;
export const CreativeTest = z.object({
  campaignId: z.string(), structure: z.object({ state: z.enum(['clean', 'drifted', 'unmeasured']),
    issues: z.array(z.string()), keywordCount: count.nullable(), adGroupCount: count, creativeCount: count }),
  rows: z.array(CreativeTestRow), ctr: CreativeMetricVerdict, cvr: CreativeMetricVerdict,
});
export type CreativeTest = z.infer<typeof CreativeTest>;

/** Product links have a fixed marketplace host and one validated advertised ASIN. */
export function creativeProductUrl(countryCode: string, asin: string | null): string | null {
  const domains: Record<string, string> = {
    US: 'www.amazon.com', CA: 'www.amazon.ca', MX: 'www.amazon.com.mx', BR: 'www.amazon.com.br',
    GB: 'www.amazon.co.uk', UK: 'www.amazon.co.uk', DE: 'www.amazon.de', FR: 'www.amazon.fr',
    IT: 'www.amazon.it', ES: 'www.amazon.es', NL: 'www.amazon.nl', SE: 'www.amazon.se',
    PL: 'www.amazon.pl', BE: 'www.amazon.com.be', IE: 'www.amazon.ie', JP: 'www.amazon.co.jp',
    AU: 'www.amazon.com.au', IN: 'www.amazon.in', SG: 'www.amazon.sg', AE: 'www.amazon.ae',
    SA: 'www.amazon.sa', TR: 'www.amazon.com.tr', EG: 'www.amazon.eg', ZA: 'www.amazon.co.za',
  };
  const domain = domains[countryCode.toUpperCase()];
  return domain && asin !== null && /^[A-Z0-9]{10}$/.test(asin) ? `https://${domain}/dp/${asin}` : null;
}
