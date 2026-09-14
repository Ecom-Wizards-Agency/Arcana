/** Versioned, replayable method contracts. Numeric policy is supplied by the caller. */
import { z } from 'zod';
import { AdProduct, EntityRef, IsoDate, Uuid } from './primitives.js';

export const MethodId = z.enum(['sp.reference-efficiency']);
export type MethodId = z.infer<typeof MethodId>;
export const MethodVersion = z.enum(['reference.1']);
export type MethodVersion = z.infer<typeof MethodVersion>;
export const MethodReleaseState = z.enum(['draft', 'reviewed', 'shadow', 'pilot', 'stable']);
export type MethodReleaseState = z.infer<typeof MethodReleaseState>;
export const MethodSelection = z.object({ id: MethodId, version: MethodVersion });
export type MethodSelection = z.infer<typeof MethodSelection>;
export const REFERENCE_METHOD: Readonly<MethodSelection> = Object.freeze({
  id: 'sp.reference-efficiency', version: 'reference.1',
});
export const MethodDescriptor = MethodSelection.extend({
  releaseState: MethodReleaseState,
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
export const MethodEvaluatorInput = z.object({
  runId: Uuid, profileId: Uuid, window: z.object({ start: IsoDate, end: IsoDate }), admittedAt: z.iso.datetime(),
  methodId: MethodId, methodVersion: MethodVersion, methodParameters: ReferenceMethodParameters,
  resolvedSettings: SettingSources, evidenceRows: z.array(ReferenceEvidenceRow).length(1),
});
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
});
export type MethodAdmissionSnapshot = z.infer<typeof MethodAdmissionSnapshot>;
