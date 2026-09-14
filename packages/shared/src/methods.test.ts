import { describe, expect, it } from 'vitest';
import {
  CalculationTrace, ExecutionVerdict, HoldReason, MethodAdmissionSnapshot, MethodDescriptor,
  MethodEvaluatorInput, ObjectiveVerdict, OneTimeRpcConfiguration, REFERENCE_METHOD,
  RecommendationInputs, ResolvedBidSettings, deriveRecommendationEvidenceClassification,
  oneTimeMethodId,
} from './index.js';

const step = { index: 0, label: 'Rounding', formula: 'round(value, precision)', inputs: [], intermediateValue: 1.234, boundApplied: null, result: 1.23 };
const trace = { steps: [step], finalResult: 1.23, roundingStep: step };
const setting = { value: 0.37, source: 'group', sourceLabel: 'Synthetic group' };

describe('method contracts', () => {
  it('validates the initial version and all ten stable hold reasons', () => {
    expect(MethodDescriptor.parse({ ...REFERENCE_METHOD, releaseState: 'stable', adProducts: ['SP'], controls: ['bid'], requiredEvidence: ['target metrics'] }).id).toBe(REFERENCE_METHOD.id);
    expect(HoldReason.options).toHaveLength(10);
    expect(MethodDescriptor.safeParse({ ...REFERENCE_METHOD, version: 'unknown' }).success).toBe(false);
  });
  it('retains method provenance and rejects unordered or inconsistent traces', () => {
    const inputs = { rpc: 2, clicks: 10, cvrSourceLevel: 'keyword', ceilingApplied: null, capClamped: false,
      methodId: REFERENCE_METHOD.id, methodVersion: REFERENCE_METHOD.version, settingSources: { targetAcos: setting }, trace };
    expect(RecommendationInputs.parse(inputs)).toEqual(inputs);
    expect(CalculationTrace.safeParse({ ...trace, steps: [{ ...step, index: 3 }] }).success).toBe(false);
    expect(CalculationTrace.safeParse({ ...trace, finalResult: 4 }).success).toBe(false);
    expect(CalculationTrace.safeParse({ ...trace, roundingStep: { ...step, result: 2 } }).success).toBe(false);
  });
  it('requires settings, frozen identities, and evidence instead of injecting values', () => {
    expect(ResolvedBidSettings.safeParse({ targetAcos: setting }).success).toBe(false);
    expect(MethodEvaluatorInput.safeParse({}).success).toBe(false);
    expect(MethodAdmissionSnapshot.safeParse({}).success).toBe(false);
    expect(MethodAdmissionSnapshot.safeParse({ version: 1, admittedAt: '2026-09-10T00:00:00Z',
      methodId: 'sp.reference-efficiency', methodVersion: 'candidate.1', strategyProvenance: {}, experiments: [] }).success).toBe(false);
  });
  it('loads persisted rpc and sends canonical identity without rewriting historical values', () => {
    const old = { version: 1, method: 'rpc', targetAcos: 0.37, bidFloor: 0.13, bidCeiling: 4.7,
      bidIncreaseCap: 0.23, bidDecreaseCap: 0.71, window: { start: '2026-08-01', end: '2026-08-26' } };
    expect(OneTimeRpcConfiguration.parse(old)).toEqual({ ...old, method: REFERENCE_METHOD.id });
    const current = OneTimeRpcConfiguration.parse({ ...old, method: REFERENCE_METHOD.id });
    expect(oneTimeMethodId(current.method)).toBe(oneTimeMethodId('rpc'));
    expect(JSON.parse(JSON.stringify(current)).method).toBe(REFERENCE_METHOD.id);
  });
});

describe('observation compatibility: all 12 verdict pairs at both maturity states', () => {
  for (const execution of ExecutionVerdict.options) {
    for (const objective of ObjectiveVerdict.options) {
      it(`${execution} / ${objective}`, () => {
        const legacy = execution === 'applied_as_intended' ? objective
          : execution === 'synchronization_conflict' ? 'synchronization_conflict' : 'not_synchronized';
        expect(deriveRecommendationEvidenceClassification(execution, objective, true)).toBe(legacy);
        expect(deriveRecommendationEvidenceClassification(execution, objective, false)).toBe(
          execution === 'applied_as_intended' ? 'observation_incomplete' : legacy,
        );
      });
    }
  }
});
