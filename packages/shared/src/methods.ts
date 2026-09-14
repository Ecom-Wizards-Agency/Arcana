/** Versioned, replayable method contracts. Numeric policy is supplied by the caller. */
import { z } from 'zod';
import { SpMarketplaceBidCapability } from './sp-marketplace-capabilities.js';
import { AdProduct, EntityRef, IsoDate, Uuid } from './primitives.js';
import { BiddingStrategy } from './entities.js';
import { SpCompleteCampaignBiddingState, SpPlacementKey } from './sp-writes.js';

export const MethodId = z.enum(['sp.reference-efficiency', 'sp.coordinated-efficiency']);
export type MethodId = z.infer<typeof MethodId>;
export const MethodVersion = z.enum(['reference.1', 'candidate.1']);
export type MethodVersion = z.infer<typeof MethodVersion>;
export const MethodReleaseState = z.enum(['draft', 'reviewed', 'shadow', 'pilot', 'stable']);
export type MethodReleaseState = z.infer<typeof MethodReleaseState>;
export const MethodSelection = z.object({ id: MethodId, version: MethodVersion }).refine((selection) =>
  selection.version === (selection.id === 'sp.reference-efficiency' ? 'reference.1' : 'candidate.1'), { message: 'Method id and version must be a registered pair.' });
export type MethodSelection = z.infer<typeof MethodSelection>;
export const REFERENCE_METHOD = Object.freeze({
  id: 'sp.reference-efficiency', version: 'reference.1',
} as const satisfies MethodSelection);
export const COORDINATED_METHOD = Object.freeze({
  id: 'sp.coordinated-efficiency', version: 'candidate.1',
} as const satisfies MethodSelection);
export function methodSelectionFor(id: MethodId): MethodSelection {
  return id === REFERENCE_METHOD.id ? { ...REFERENCE_METHOD } : { ...COORDINATED_METHOD };
}
export const MethodDescriptor = MethodSelection.safeExtend({
  releaseState: MethodReleaseState,
  placementEvaluator: z.enum(['reference', 'coordinated']).optional(),
  objectivePolicy: z.enum(['reference_goal_policy', 'attributed_revenue_efficiency']).optional(),
  adProducts: z.array(AdProduct).min(1),
  controls: z.array(z.enum(['bid', 'placement', 'audience', 'bidding_mode', 'budget'])).min(1),
  requiredEvidence: z.array(z.string().min(1)).min(1),
});
export type MethodDescriptor = z.infer<typeof MethodDescriptor>;

export const SettingSource = z.enum(['run', 'group', 'tenant_strategy', 'default']);
export type SettingSource = z.infer<typeof SettingSource>;
export const SettingValue = z.union([z.number(), z.string(), z.boolean(), z.null()]);
export type SettingValue = z.infer<typeof SettingValue>;
export function resolvedSettingSchema<T extends z.ZodType>(value: T) {
  return z.object({ value, source: SettingSource, sourceLabel: z.string().min(1) });
}
export const ResolvedSetting = resolvedSettingSchema(SettingValue);
export type ResolvedSetting<T = SettingValue> = Omit<z.infer<typeof ResolvedSetting>, 'value'> & { value: T };
export const SettingSources = z.record(z.string(), ResolvedSetting);
export type SettingSources = z.infer<typeof SettingSources>;
export const ResolvedBidSettings = z.object({
  targetAcos: resolvedSettingSchema(z.number().positive()),
  bidFloor: resolvedSettingSchema(z.number().nonnegative()),
  bidCeiling: resolvedSettingSchema(z.number().positive()),
  bidIncreaseCap: resolvedSettingSchema(z.number().nonnegative()),
  bidDecreaseCap: resolvedSettingSchema(z.number().min(0).max(1)),
});
export type ResolvedBidSettings = z.infer<typeof ResolvedBidSettings>;

export const CalculationInput = z.object({ name: z.string().min(1), value: SettingValue, unit: z.string().min(1) });
export const CalculationStep = z.object({
  index: z.number().int().nonnegative(), label: z.string().min(1), formula: z.string().min(1),
  inputs: z.array(CalculationInput), intermediateValue: z.number().nullable(),
  boundApplied: z.object({ name: z.string().min(1), value: z.number(), before: z.number(), after: z.number() }).nullable(),
  result: z.number().nullable(),
});
export type CalculationStep = z.infer<typeof CalculationStep>;
export const CalculationTrace = z.object({
  steps: z.array(CalculationStep).min(1), finalResult: z.number().nullable(), roundingStep: CalculationStep,
}).superRefine((trace, ctx) => {
  if (trace.steps.some((step, index) => step.index !== index)) {
    ctx.addIssue({ code: 'custom', path: ['steps'], message: 'Calculation steps must have consecutive ordered indexes.' });
  }
  if (JSON.stringify(trace.steps[trace.roundingStep.index]) !== JSON.stringify(trace.roundingStep)) {
    ctx.addIssue({ code: 'custom', path: ['roundingStep'], message: 'Rounding must identify a saved calculation step.' });
  }
  if (trace.steps.at(-1)?.result !== trace.finalResult) {
    ctx.addIssue({ code: 'custom', path: ['finalResult'], message: 'Final result must match the last saved step.' });
  }
});
export type CalculationTrace = z.infer<typeof CalculationTrace>;
export const HoldReason = z.enum([
  'ATTRIBUTION_INCOMPLETE', 'NO_FEASIBLE_CONTROL_SET', 'EXPERIMENT_LOCK',
  'MIXED_INTENT_PLACEMENT_PROXY', 'ZERO_BASELINE_RPC', 'STALE_STATE', 'MISSING_SETTING',
  'INSUFFICIENT_EVIDENCE', 'GUARDRAIL_BLOCKED', 'ENTITY_INACTIVE',
]);
export type HoldReason = z.infer<typeof HoldReason>;
export const Hold = z.object({
  reason: HoldReason, prose: z.string().min(1), affectedScope: z.array(EntityRef).min(1),
  reconsiderWhen: z.string().min(1),
});
export type Hold = z.infer<typeof Hold>;

/** Canonical reference vocabulary, also used by the original bid API. */
export const MethodMetrics = z.object({ clicks: z.number(), orders: z.number(), sales: z.number(), cost: z.number().optional() });
export type MethodMetrics = z.infer<typeof MethodMetrics>;
export const MethodConfidenceLevels = z.object({
  keyword: MethodMetrics.optional(), adGroup: MethodMetrics.optional(), campaign: MethodMetrics.optional(), profile: MethodMetrics,
});
export type MethodConfidenceLevels = z.infer<typeof MethodConfidenceLevels>;
export const ReferenceChangeCaps = z.object({
  maxIncrease: z.number(), maxDecrease: z.number(), maxPlacementIncrease: z.number().nullable().optional(), maxPlacementDecrease: z.number().nullable().optional(),
});
export const ReferenceCeilings = z.object({
  manualMaxBid: z.number().nullable().optional(), dailyBudget: z.number().nullable().optional(),
  budgetShareCeiling: z.number().nullable().optional(), suggestedBid: z.number().nullable().optional(),
});
export const ReferenceFloors = z.object({
  manualMinBid: z.number().nullable().optional(), suggestedBidLow: z.number().nullable().optional(), dynamicFloorShare: z.number().nullable().optional(),
});
export const ReferenceBidSettings = z.object({
  graceRange: z.number(), lowAcosBuffer: z.number(), lowAcosStepPct: z.number(), lowVisibilityStepPct: z.number(),
  lowVisibilityClicksBand: z.number(), nonConvertingModel: z.enum(['projected', 'simple']), minBid: z.number(),
  bidPrecision: z.number().int().nonnegative(), minOrdersForConfidence: z.number(),
});
export const MethodStockSignal = z.discriminatedUnion('status', [
  z.object({ status: z.literal('in_stock'), asins: z.array(z.string()).readonly(), source: z.string().optional() }),
  z.object({ status: z.literal('out_of_stock'), asins: z.array(z.string()).readonly(), source: z.string().optional() }),
  z.object({ status: z.literal('unknown'), asins: z.array(z.string()).readonly(), reason: z.string().optional() }),
]);
export const MethodRankSignal = z.discriminatedUnion('status', [
  z.object({ status: z.literal('known'), currentRank: z.number(), previousRank: z.number().nullable(), asin: z.string().optional(), observedOn: z.string().optional() }),
  z.object({ status: z.literal('unknown'), reason: z.string().optional() }),
  z.object({ status: z.literal('not_applicable') }),
]);
export const ReferenceBidRequest = z.object({
  runId: Uuid, profileId: Uuid, entityRef: EntityRef, adProduct: AdProduct,
  window: z.object({ start: IsoDate, end: IsoDate }), currentBid: z.number().nullable(),
  metrics: MethodMetrics, levels: MethodConfidenceLevels, targetAcos: z.number(),
  caps: ReferenceChangeCaps, ceilings: ReferenceCeilings.optional(), floors: ReferenceFloors.optional(),
  category: z.string().optional(), goal: z.string().nullable().optional(), stock: MethodStockSignal.optional(),
  organicRank: MethodRankSignal.optional(), pacingCondition: z.enum(['on_target', 'under_pacing', 'launch']).optional(),
  cutOnAcosAlone: z.boolean().optional(), settings: ReferenceBidSettings.partial().optional(),
});
export type ReferenceBidRequest = z.infer<typeof ReferenceBidRequest>;
export const ReferenceMethodParameters = ReferenceBidRequest.pick({ targetAcos: true, caps: true, ceilings: true, floors: true, settings: true });
export type ReferenceMethodParameters = z.infer<typeof ReferenceMethodParameters>;
export const ReferenceEvidenceRow = ReferenceBidRequest.omit({ runId: true, profileId: true, window: true, targetAcos: true, caps: true, ceilings: true, floors: true, settings: true });
/** API mechanics, not tenant doctrine. Currency amounts are in the profile currency. */
export const CostType = z.enum(['cpc', 'vcpm']);
export type CostType = z.infer<typeof CostType>;
export const ControlKind = z.enum(['target_bid', 'placement_adjustment', 'audience_adjustment', 'bidding_mode']);
export type ControlKind = z.infer<typeof ControlKind>;
export const ControlUnit = z.enum(['currency_per_click', 'currency_per_thousand_impressions', 'percentage', 'mode']);
export type ControlUnit = z.infer<typeof ControlUnit>;
export const CapabilityMatrixEntry = z.object({
  adProduct: AdProduct, costType: CostType, control: ControlKind, placementKey: SpPlacementKey.optional(),
  available: z.boolean(), unit: ControlUnit,
  range: z.object({ min: z.number(), max: z.number().nullable() }).nullable(),
  precision: z.enum(['integer', 'decimal', 'enum']), decimalPlaces: z.number().int().nonnegative().nullable(),
  overlapRule: z.enum(['exclusive', 'multiplicative', 'unknown', 'not_applicable']),
  apiVersion: z.string().min(1), verifiedOn: IsoDate,
});
export type CapabilityMatrixEntry = z.infer<typeof CapabilityMatrixEntry>;
export const CapabilityMatrix = z.object({ version: z.string().min(1), entries: z.array(CapabilityMatrixEntry).min(1), marketplace: SpMarketplaceBidCapability.nullable().optional() });
export type CapabilityMatrix = z.infer<typeof CapabilityMatrix>;
export const ExposureCeiling = resolvedSettingSchema(z.number().positive());
export type ExposureCeiling = z.infer<typeof ExposureCeiling>;
const ControlIdentity = z.object({ entityRef: EntityRef });
export const ControlChange = z.discriminatedUnion('control', [
  ControlIdentity.extend({ control: z.literal('target_bid'), current: z.number().nonnegative(), proposed: z.number().positive(), unit: z.literal('currency_per_click') }),
  ControlIdentity.extend({ control: z.literal('placement_adjustment'), placementKey: SpPlacementKey,
    current: z.number().int().min(0).max(900), proposed: z.number().int().min(0).max(900), unit: z.literal('percentage') }),
  ControlIdentity.extend({ control: z.literal('audience_adjustment'), audienceId: z.string().min(1),
    current: z.number().int().min(0).max(900), proposed: z.number().int().min(0).max(900), unit: z.literal('percentage') }),
  ControlIdentity.extend({ control: z.literal('bidding_mode'), current: BiddingStrategy, proposed: BiddingStrategy, unit: z.literal('mode') }),
]);
export type ControlChange = z.infer<typeof ControlChange>;
export const DependencySet = z.object({
  id: z.string().min(1), campaignId: z.string().min(1), changes: z.array(ControlChange).min(1),
  /** Entry i explains why change i must precede change i+1. */
  precedenceReasons: z.array(z.string().min(1)),
}).superRefine((set, ctx) => {
  if (set.precedenceReasons.length !== set.changes.length - 1) ctx.addIssue({ code: 'custom', message: 'Every adjacent step needs its precedence reason.' });
  const keys = set.changes.map((c) => JSON.stringify([c.entityRef.entityType, c.entityRef.entityId, c.control,
    c.control === 'placement_adjustment' ? c.placementKey : c.control === 'audience_adjustment' ? c.audienceId : null]));
  if (new Set(keys).size !== keys.length || set.changes.some((c) => c.current === c.proposed
    || c.entityRef.campaignId !== set.campaignId || c.entityRef.profileId !== set.changes[0]?.entityRef.profileId)) {
    ctx.addIssue({ code: 'custom', message: 'A dependency set needs distinct changed controls in one campaign and profile.' });
  }
});
export type DependencySet = z.infer<typeof DependencySet>;
export const PlacementEvidenceRequirements = z.enum(['single_target', 'validated_homogeneous']);
export type PlacementEvidenceRequirements = z.infer<typeof PlacementEvidenceRequirements>;
export const CoordinatedMethodSettings = z.object({
  exposureCeiling: z.number().positive(), placementEvidenceRequirements: PlacementEvidenceRequirements,
  minClicksPerPlacement: z.number().int().positive(),
});
export type CoordinatedMethodSettings = z.infer<typeof CoordinatedMethodSettings>;
export const ResolvedCoordinatedSettings = z.object({
  exposureCeiling: ExposureCeiling,
  placementEvidenceRequirements: resolvedSettingSchema(PlacementEvidenceRequirements),
  minClicksPerPlacement: resolvedSettingSchema(z.number().int().positive()),
});
export type ResolvedCoordinatedSettings = z.infer<typeof ResolvedCoordinatedSettings>;
export const CoordinatedMethodParameters = ReferenceMethodParameters.extend({
  ...CoordinatedMethodSettings.shape,
  targetAcos: z.number().positive(),
  caps: ReferenceChangeCaps.extend({ maxIncrease: z.number().nonnegative(), maxDecrease: z.number().min(0).max(1) }),
  floors: ReferenceFloors.extend({ manualMinBid: z.number().nonnegative() }),
  ceilings: ReferenceCeilings.extend({ manualMaxBid: z.number().positive() }),
});
export type CoordinatedMethodParameters = z.infer<typeof CoordinatedMethodParameters>;
export const MethodParameterSchemas = {
  'sp.reference-efficiency': ReferenceMethodParameters,
  'sp.coordinated-efficiency': CoordinatedMethodParameters,
} as const;
export const CampaignPlacementFact = z.object({
  campaignId: z.string().min(1), placement: z.enum(['top_of_search', 'rest_of_search', 'product_pages']),
  clicks: z.number().int().nonnegative(), sales: z.number().nonnegative(), clickShare: z.number().min(0).max(1),
});
export type CampaignPlacementFact = z.infer<typeof CampaignPlacementFact>;
export const CoordinatedCampaignEvidence = z.object({
  campaignId: z.string().min(1), costType: CostType, currentControls: SpCompleteCampaignBiddingState.nullable(),
  targetCount: z.number().int().positive(), complete: z.boolean(), attributionMature: z.boolean(),
  homogeneousProxyValidation: z.string().min(1).nullable(),
  placementFacts: z.array(CampaignPlacementFact), capabilities: CapabilityMatrix,
});
export type CoordinatedCampaignEvidence = z.infer<typeof CoordinatedCampaignEvidence>;
const MethodInputContext = z.object({
  runId: Uuid, profileId: Uuid, window: z.object({ start: IsoDate, end: IsoDate }), admittedAt: z.iso.datetime(),
  resolvedSettings: SettingSources,
});
export const ReferenceMethodInput = MethodInputContext.extend({
  methodId: z.literal('sp.reference-efficiency'), methodVersion: z.literal('reference.1'),
  methodParameters: ReferenceMethodParameters, evidenceRows: z.array(ReferenceEvidenceRow).length(1),
});
export type ReferenceMethodInput = z.infer<typeof ReferenceMethodInput>;
export const CoordinatedMethodInput = MethodInputContext.extend({
  methodId: z.literal('sp.coordinated-efficiency'), methodVersion: z.literal('candidate.1'),
  methodParameters: CoordinatedMethodParameters, evidenceRows: z.array(ReferenceEvidenceRow).min(1),
  campaignEvidence: CoordinatedCampaignEvidence,
});
export type CoordinatedMethodInput = z.infer<typeof CoordinatedMethodInput>;
export const MethodEvidenceSchemas = {
  'sp.reference-efficiency': ReferenceMethodInput.pick({ evidenceRows: true }),
  'sp.coordinated-efficiency': CoordinatedMethodInput.pick({ evidenceRows: true, campaignEvidence: true }),
} as const;
export const MethodEvaluatorInput = z.discriminatedUnion('methodId', [ReferenceMethodInput, CoordinatedMethodInput]);
export type MethodEvaluatorInput = z.infer<typeof MethodEvaluatorInput>;

/** Admission evidence travels through the existing run-context JSON, including fenced reads. */
export const MethodExperimentScope = z.object({
  campaignIds: z.array(z.string()).optional(), adGroupIds: z.array(z.string()).optional(),
  targetIds: z.array(z.string()).optional(), asins: z.array(z.string()).optional(),
  searchTerms: z.array(z.string()).optional(), note: z.string().optional(),
});
export const MethodExperiment = z.object({
  id: Uuid, scope: MethodExperimentScope, status: z.enum(['planned', 'running', 'ended', 'analyzed', 'aborted']),
  startAt: z.iso.datetime(), endAt: z.iso.datetime().nullable(),
});
export type MethodExperiment = z.infer<typeof MethodExperiment>;
export const StrategyProvenance = z.record(z.string(), z.enum(['defaults', 'goal_lens', 'tenant', 'profile']));
export type StrategyProvenance = z.infer<typeof StrategyProvenance>;
export const MethodAdmissionSnapshot = z.object({
  version: z.literal(1), admittedAt: z.iso.datetime(), methodId: MethodId, methodVersion: MethodVersion,
  strategyProvenance: StrategyProvenance, experiments: z.array(MethodExperiment),
  campaignMethods: z.record(z.string(), MethodSelection).optional(),
}).refine((snapshot) => MethodSelection.safeParse({ id: snapshot.methodId, version: snapshot.methodVersion }).success,
  { message: 'The admitted method id and version must be a registered pair.' });
export type MethodAdmissionSnapshot = z.infer<typeof MethodAdmissionSnapshot>;
