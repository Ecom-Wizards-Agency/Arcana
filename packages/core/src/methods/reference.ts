import {
  REFERENCE_METHOD, type MethodDescriptor, type MethodEvaluatorInput, type MethodEvaluatorOutput,
  type ReferenceMethodInput, type ReferenceBidRequest, type SettingSources,
} from '@wizard-ads/shared';
import { evaluateBidWithTrace, resolveReferenceBidSettings } from '../bidding/bid.js';

export const referenceDescriptor: MethodDescriptor = {
  ...REFERENCE_METHOD, releaseState: 'stable', adProducts: ['SP'], controls: ['bid'],
  placementEvaluator: 'reference', objectivePolicy: 'reference_goal_policy',
  requiredEvidence: ['target clicks, orders, sales and cost', 'current bid and campaign controls', 'confidence benchmarks', 'stock and rank signals'],
};

/** Adapt the old API once; all scalar parameter values remain visible in the snapshot. */
export function referenceMethodInput(request: ReferenceBidRequest, admittedAt: string, sources: SettingSources = {}): ReferenceMethodInput {
  const { runId, profileId, window, targetAcos, caps, ceilings, floors, settings, ...evidence } = request;
  const resolvedSettings: SettingSources = {};
  for (const [name, value] of Object.entries(resolveReferenceBidSettings(request))) {
    resolvedSettings[name] = { value, source: settings?.[name as keyof typeof settings] === undefined ? 'default' : 'run', sourceLabel: request.pacingCondition !== undefined || request.goal === 'rank-launch' ? 'Reference settings with admitted pacing condition' : 'Reference bid settings' };
  }
  for (const [name, value] of Object.entries({ targetAcos, bidFloor: floors?.manualMinBid ?? null,
    bidCeiling: ceilings?.manualMaxBid ?? null, bidIncreaseCap: caps.maxIncrease, bidDecreaseCap: caps.maxDecrease })) {
    resolvedSettings[name] = { value, source: 'run', sourceLabel: 'Reference request' };
  }
  return { runId, profileId, window, admittedAt, methodId: REFERENCE_METHOD.id, methodVersion: REFERENCE_METHOD.version,
    methodParameters: { targetAcos, caps, ...(ceilings === undefined ? {} : { ceilings }), ...(floors === undefined ? {} : { floors }), ...(settings === undefined ? {} : { settings }) },
    resolvedSettings: { ...resolvedSettings, ...sources }, evidenceRows: [evidence] };
}

export function evaluateReferenceMethod(input: MethodEvaluatorInput): MethodEvaluatorOutput {
  if (input.methodId !== 'sp.reference-efficiency') throw new Error('Reference method identity mismatch');
  const evidence = input.evidenceRows[0];
  if (evidence === undefined) throw new Error('Reference method requires one evidence row');
  const request: ReferenceBidRequest = { runId: input.runId, profileId: input.profileId, window: input.window, ...input.methodParameters, ...evidence };
  const canonical = referenceMethodInput(request, input.admittedAt).resolvedSettings;
  for (const [name, setting] of Object.entries(canonical)) {
    if (input.resolvedSettings[name]?.value !== setting.value) throw new Error(`Resolved setting disagrees with method parameters: ${name}`);
  }
  const { outcome, trace } = evaluateBidWithTrace(request, input.resolvedSettings);
  if (outcome.kind === 'proposal') {
    if (trace === null) throw new Error('Reference proposal has no calculation trace');
    return { kind: 'proposal', changes: [outcome.recommendation], trace, dependencies: [], referenceOutcome: outcome };
  }
  return { kind: 'hold', referenceOutcome: outcome, hold: {
    reason: outcome.kind === 'blocked' || outcome.kind === 'suppressed' ? 'GUARDRAIL_BLOCKED'
      : outcome.reason === 'no_benchmark_data' || outcome.reason === 'no_clicks' ? 'INSUFFICIENT_EVIDENCE' : 'GUARDRAIL_BLOCKED',
    prose: outcome.kind === 'blocked' ? outcome.note : outcome.kind === 'suppressed' ? outcome.suppressedReason : `Reference method retained the current bid: ${outcome.reason}.`,
    affectedScope: [evidence.entityRef], reconsiderWhen: 'Re-evaluate after the relevant evidence, eligibility, or settings change.',
  } };
}
