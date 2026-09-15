import { CampaignCreationApprovalView } from './campaign-creation-approval.js';
import { AssetLibrarySnapshot, UsedCampaignCreative } from './asset-library.js';
import { z } from 'zod';
import { CurrencyCode, Uuid } from './primitives.js';
import { NamingStrategy } from './strategy.js';
import { OptimizationGroupRole } from './optimization.js';
import { CapabilityMatrix } from './methods.js';
import { SpMarketplaceScope } from './sp-marketplace-capabilities.js';
import { CampaignCreationPlan, CampaignCreationSha256, CampaignCreationExecutionSnapshot } from './campaign-creation.js';

export const CampaignBuilderAdType = z.enum(['SP', 'SB', 'SBV', 'SD']);
export type CampaignBuilderAdType = z.infer<typeof CampaignBuilderAdType>;
export const CampaignBuilderKeywordSource = z.enum(['paste', 'search-terms', 'ngrams', 'rank-radar', 'saved']);
export const CampaignBuilderKeyword = z.object({ text: z.string().trim().min(1).max(512), bid: z.number().finite().positive(), basis: z.enum(['keyword_cpc', 'sqp_value', 'manual']) }).strict();
export type CampaignBuilderKeyword = z.infer<typeof CampaignBuilderKeyword>;
export const CampaignBuilderRecipe = z.object({
  adType: CampaignBuilderAdType, productKeys: z.array(z.string().min(1)).min(1),
  play: OptimizationGroupRole, groupId: Uuid, dailyBudget: z.number().finite().positive(),
  keywords: z.array(CampaignBuilderKeyword).min(1),
  structure: z.enum(['keyword-product', 'set-product']),
  topOfSearch: z.number().int().min(0).max(900), audienceAdjustment: z.number().int().min(0).max(900),
  naming: NamingStrategy, names: z.record(z.string(), z.string().trim().min(1).max(256)).default({}),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.productKeys).size !== value.productKeys.length
    || new Set(value.keywords.map((k) => k.text.toLocaleLowerCase())).size !== value.keywords.length) {
    ctx.addIssue({ code: 'custom', message: 'Products and keywords must be distinct' });
  }
});
export type CampaignBuilderRecipe = z.infer<typeof CampaignBuilderRecipe>;

export const CampaignBuilderBidEvidence = z.object({
  keyword: z.string(), clicks: z.number().int().nonnegative(), spend: z.number().nonnegative(),
  reportedCpc: z.number().nonnegative().nullable(), days: z.number().int().nonnegative(),
  start: z.iso.date(), end: z.iso.date(), source: z.literal('fact_sp_target_daily'),
  sourceRows: z.number().int().nonnegative(), sales: z.number().nonnegative().nullable(),
}).strict();
export type CampaignBuilderBidEvidence = z.infer<typeof CampaignBuilderBidEvidence>;
export const CampaignBuilderBidBounds = z.object({ floor: z.number().positive().nullable(), ceiling: z.number().positive().nullable(), exposureCeiling: z.number().positive().nullable(), decimalPlaces: z.number().int().min(0).max(6) }).strict();
export type CampaignBuilderBidBounds = z.infer<typeof CampaignBuilderBidBounds>;
export const CampaignBuilderCheck = z.object({
  id: z.enum(['budget', 'unique-name', 'naming', 'exposure', 'capability', 'stock', 'buy-box', 'suppression', 'moderation', 'product', 'permission', 'count']),
  label: z.string(), source: z.string(), status: z.enum(['passed', 'blocked', 'not_measured']),
  blocking: z.boolean(), currentValue: z.string(), requiredAction: z.string(),
}).strict().superRefine((value, ctx) => {
  if (value.status === 'passed' && value.blocking) ctx.addIssue({ code: 'custom', message: 'Passed checks cannot block' });
});
export type CampaignBuilderCheck = z.infer<typeof CampaignBuilderCheck>;
export const CampaignBuilderValidation = z.object({
  planFingerprint: CampaignCreationSha256, recipeFingerprint: CampaignCreationSha256,
  checkedAt: z.iso.datetime(), checks: z.array(CampaignBuilderCheck),
}).strict().superRefine((value, ctx) => {
  const required = CampaignBuilderCheck.shape.id.options;
  if (value.checks.length !== required.length || new Set(value.checks.map((check) => check.id)).size !== required.length
    || required.some((id) => !value.checks.some((check) => check.id === id))) ctx.addIssue({ code: 'custom', message: 'Validation must cover every check exactly once' });
  for (const check of value.checks) {
    const unmeasured = ['stock', 'buy-box', 'suppression', 'moderation'].includes(check.id);
    if (unmeasured && (check.status !== 'not_measured' || check.blocking)
      || !unmeasured && (check.status !== 'passed') !== check.blocking) ctx.addIssue({ code: 'custom', message: 'Missing runnable checks must block; listing and moderation remain unmeasured' });
  }
});
export type CampaignBuilderValidation = z.infer<typeof CampaignBuilderValidation>;
export const CampaignDraft = z.object({
  id: Uuid, orgId: Uuid, profileId: Uuid, createdBy: Uuid,
  status: z.enum(['draft', 'validated', 'blocked', 'approved']),
  revision: z.number().int().positive(), plan: CampaignCreationPlan, recipe: CampaignBuilderRecipe,
  rationale: z.array(z.object({ keyword: z.string(), sentence: z.string(), frozenAt: z.iso.datetime() }).strict()),
  validation: CampaignBuilderValidation.nullable(), updatedAt: z.iso.datetime(),
}).strict().superRefine((value, ctx) => {
  if (value.plan.orgId !== value.orgId || value.plan.profileId !== value.profileId
    || (value.validation !== null && value.validation.planFingerprint !== value.plan.fingerprint)
    || (value.status === 'draft' && value.validation !== null)
    || (value.status !== 'draft' && value.validation === null)
    || (value.status === 'validated' && value.validation?.checks.some((check) => check.blocking))
    || (value.status === 'blocked' && !value.validation?.checks.some((check) => check.blocking))) {
    ctx.addIssue({ code: 'custom', message: 'Draft scope, status and validation must agree' });
  }
});
export type CampaignDraft = z.infer<typeof CampaignDraft>;
export const CampaignNamingPreset = z.object({ id: Uuid, name: z.string().trim().min(1).max(200), naming: NamingStrategy, createdBy: Uuid, usageCount: z.number().int().nonnegative() }).strict();
export type CampaignNamingPreset = z.infer<typeof CampaignNamingPreset>;
export const CampaignKeywordSet = z.object({ id: Uuid, profileId: Uuid, name: z.string().trim().min(1).max(200), keywords: z.array(z.string().trim().min(1).max(512)).min(1) }).strict();
export type CampaignKeywordSet = z.infer<typeof CampaignKeywordSet>;

export const CampaignBuilderContext = z.object({
  profile: z.object({ id: Uuid, label: z.string(), countryCode: z.string(), currencyCode: CurrencyCode, marketplace: SpMarketplaceScope.nullable() }).strict(),
  products: z.array(z.object({ key: z.string(), asin: z.string(), sku: z.string().nullable(), name: z.string(), state: z.string(), observedAt: z.string().nullable() }).strict()),
  groups: z.array(z.object({ id: Uuid, name: z.string(), role: OptimizationGroupRole, targetAcos: z.number().nullable(), floor: z.number().nullable(), ceiling: z.number().nullable() }).strict()),
  naming: NamingStrategy.nullable(), presets: z.array(CampaignNamingPreset), keywordSets: z.array(CampaignKeywordSet),
  searchTerms: z.array(z.string()), ngrams: z.array(z.string()), bidEvidence: z.array(CampaignBuilderBidEvidence),
  sqpMeasured: z.boolean(), exposureCeiling: z.number().positive().nullable(),
  budget: z.object({ minimum: z.number(), maximum: z.number() }).nullable(),
  capabilities: CapabilityMatrix, canEdit: z.boolean(), today: z.iso.date(),
  defaults: z.object({ budget: z.number().nullable(), topOfSearch: z.number().nullable() }).strict(),
}).strict();
export type CampaignBuilderContext = z.infer<typeof CampaignBuilderContext>;

/** A display capability is insufficient to admit a write. A later executor must also register. */
export function campaignCreationExecutorAvailable(environment: Readonly<Record<string, string | undefined>>, executorRegistered = false): boolean {
  return executorRegistered && environment['CAMPAIGN_CREATION_EXECUTOR_ENABLED'] === 'true';
}
export const CAMPAIGN_CREATION_UNAVAILABLE = 'Creation in Amazon is not available yet. Export the bulk sheet to create these campaigns through Bulk Operations.';

/** Row outcomes supplement the existing aggregate contract; no provider payload is exposed. */
export const CampaignBuilderResult = z.object({
  snapshot: CampaignCreationExecutionSnapshot,
  resources: z.array(z.object({ nodeId: Uuid, kind: z.enum(['campaign', 'ad_group', 'product_ad', 'keyword']), requested: z.number().int().nonnegative(), succeeded: z.number().int().nonnegative(), status: z.enum(['created', 'failed', 'pending', 'unknown']), message: z.string().nullable(), responseCode: z.string().min(1).max(128).nullable().optional() }).strict()),
  retry: z.object({ requested: z.number().int().nonnegative(), created: z.number().int().nonnegative(), duplicated: z.number().int().nonnegative() }).strict().nullable(),
  campaignState: z.literal('paused'), currencyCode: CurrencyCode,
}).strict().superRefine((value, ctx) => {
  if (value.resources.reduce((n, row) => n + row.requested, 0) !== value.snapshot.accounting.operatorApproved
    || value.resources.reduce((n, row) => n + row.succeeded, 0) !== value.snapshot.accounting.succeeded
    || value.resources.filter((row) => row.status === 'failed').length !== value.snapshot.accounting.failed
    || new Set(value.resources.map((row) => row.nodeId)).size !== value.resources.length
    || value.resources.some((row) => row.requested !== 1 || row.succeeded > row.requested
      || (row.status === 'created') !== (row.succeeded === row.requested))
    || (value.retry !== null && (value.retry.created > value.retry.requested || value.retry.duplicated > value.retry.created))) {
    ctx.addIssue({ code: 'custom', message: 'Result rows must reconcile with the execution snapshot' });
  }
});
export type CampaignBuilderResult = z.infer<typeof CampaignBuilderResult>;

/** Display guidance from the reviewed page-12 capability snapshot. This does not
 * authorize a provider write; execution still requires the coordinated matrix. */
export const CAMPAIGN_AD_TYPE_SNAPSHOT = {
  version: 'campaign-ad-types.2026-09-15.v1',
  entries: [
    { adType: 'SP', name: 'Sponsored Products', cost: 'CPC', source: 'Page 12, node 95:2; SP coordinated capabilities and marketplace rules', rows: [
      { supported: true, label: 'Keyword and product targeting' }, { supported: true, label: 'Three placement adjustments' },
      { supported: true, label: 'Fixed, down-only, up-and-down' }, { supported: true, label: 'Product ads from your catalogue' }, { supported: false, label: 'No creative to choose' },
    ] },
    { adType: 'SB', name: 'Sponsored Brands', cost: 'CPC', source: 'Page 12, node 95:2, reviewed capability guidance; creation executor unavailable', rows: [
      { supported: true, label: 'Keyword targeting' }, { supported: true, label: 'Top and rest of search adjustments' }, { supported: true, label: 'Headline, logo, destination' },
      { supported: false, label: 'No product-page adjustment' }, { supported: false, label: 'Negative adjustments may not be supported' },
    ] },
    { adType: 'SBV', name: 'Sponsored Brands video', cost: 'CPC', source: 'Page 12, node 95:2, reviewed capability guidance; creation executor unavailable', rows: [
      { supported: true, label: 'Keyword targeting' }, { supported: true, label: 'A video asset' }, { supported: true, label: 'Store or detail-page destination' }, { supported: false, label: 'Same placement limits as SB' },
    ] },
    { adType: 'SD', name: 'Sponsored Display', cost: 'CPC or vCPM', source: 'Page 12, node 95:2, reviewed capability guidance; creation executor unavailable', rows: [
      { supported: true, label: 'Audience or product targeting' }, { supported: true, label: 'Cost type decides everything else' }, { supported: false, label: 'No SP placements' }, { supported: false, label: 'No SP bidding modes' },
    ] },
  ],
} as const;

/** Serialized screen evidence; inert fixture adapters never grant execution authority. */
const unavailable = z.object({ view: z.enum(['error', 'empty', 'gated', 'not-measured']), message: z.string() });
export const BuilderRouteData = z.union([z.object({ view: z.literal('ready'), context: CampaignBuilderContext, step: z.enum(['products', 'targets', 'review']), initialRecipe: CampaignBuilderRecipe.optional(), initialSource: z.enum(['paste', 'search-terms', 'ngrams', 'rank-radar', 'saved']).optional() }), unavailable]);
export const DraftRouteData = z.union([z.object({ view: z.literal('ready'), context: CampaignBuilderContext, draft: CampaignDraft, review: CampaignCreationApprovalView, executorAvailable: z.boolean(), step: z.string(), result: CampaignBuilderResult.optional(), fixtureExecutor: z.literal('inert').optional() }), unavailable]);
export const NamingRouteData = z.union([z.object({ view: z.literal('ready'), profileId: Uuid, naming: NamingStrategy.nullable(), presets: z.array(CampaignNamingPreset), profiles: z.array(z.object({ id: Uuid, label: z.string() })), canEdit: z.boolean() }), unavailable]);
export const AssetsRouteData = z.union([z.object({ view: z.literal('ready'), profileId: Uuid, snapshot: AssetLibrarySnapshot.nullable(), used: z.array(UsedCampaignCreative), canRefresh: z.boolean(), initialTab: z.enum(['library', 'used', 'upload']).optional() }), unavailable]);
export const UpdateRouteData = z.union([z.object({ view: z.literal('ready'), profileId: Uuid, profileLabel: z.string(), marketplace: z.string() }), unavailable]);

export type BuilderRouteData = z.infer<typeof BuilderRouteData>;
export type DraftRouteData = z.infer<typeof DraftRouteData>;
export type NamingRouteData = z.infer<typeof NamingRouteData>;
export type AssetsRouteData = z.infer<typeof AssetsRouteData>;
export type UpdateRouteData = z.infer<typeof UpdateRouteData>;
