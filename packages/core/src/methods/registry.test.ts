import { describe, expect, it } from 'vitest';
import { CalculationTrace, REFERENCE_METHOD, type ReferenceBidRequest } from '@wizard-ads/shared';
import { createMethodRegistry, registerMethod, resolveMethod } from './registry.js';
import { referenceDescriptor, referenceMethodInput } from './reference.js';
const request: ReferenceBidRequest = {
  runId: '11111111-1111-4111-8111-111111111111', profileId: '22222222-2222-4222-8222-222222222222',
  entityRef: { profileId: '22222222-2222-4222-8222-222222222222', entityType: 'keyword', entityId: 'synthetic-kw' },
  adProduct: 'SP', window: { start: '2026-08-01', end: '2026-08-26' }, currentBid: 1,
  metrics: { clicks: 10, orders: 2, sales: 20, cost: 10 }, levels: { profile: { clicks: 10, orders: 2, sales: 20 } },
  targetAcos: 0.31, caps: { maxIncrease: 0.17, maxDecrease: 0.27 },
  ceilings: { manualMaxBid: 0.43 }, floors: { manualMinBid: 0.817 },
};
const input = () => referenceMethodInput(request, '2026-08-27T00:00:00Z', { targetAcos: { value: 0.31, source: 'group', sourceLabel: 'Synthetic group' } });
describe('method registry', () => {
  it('records arithmetic, applied bounds, and both rounding directions in execution order', () => {
    const result = resolveMethod(REFERENCE_METHOD.id, REFERENCE_METHOD.version).evaluate(input());
    expect(result.kind).toBe('proposal');
    if (result.kind !== 'proposal') throw new Error('expected proposal');
    expect(result.trace.steps.map((step) => step.label)).toEqual([
      'Inputs', 'RPC', 'Target ACOS', 'Raw bid', 'Ceiling: manual_max_bid', 'Change cap',
      'Rounding: initial', 'Floor: manual_min_bid', 'Rounding: floor',
    ]);
    expect(result.trace.steps.filter((step) => step.boundApplied !== null).map((step) => step.boundApplied)).toEqual([
      { name: 'manual_max_bid', value: 0.43, before: 0.62, after: 0.43 },
      { name: 'max_decrease', value: 0.73, before: 0.43, after: 0.73 },
      { name: 'manual_min_bid', value: 0.817, before: 0.73, after: 0.817 },
    ]);
    expect(result.trace.steps[2]?.inputs).toContainEqual({ name: 'source', value: 'group', unit: 'source' });
    expect(result.trace.finalResult).toBe(0.82);
    expect(CalculationTrace.parse(result.trace)).toEqual(result.trace);
    expect(result.changes[0]?.proposedValue).toBe(result.trace.finalResult);
  });
  it('rejects duplicate or unavailable versions and mismatched setting provenance', () => {
    const method = resolveMethod(REFERENCE_METHOD.id, REFERENCE_METHOD.version);
    expect(() => createMethodRegistry([method, method])).toThrow(/Duplicate/);
    expect(() => createMethodRegistry([]).resolveMethod(REFERENCE_METHOD.id, REFERENCE_METHOD.version)).toThrow(/Unknown/);
    const altered = input();
    altered.resolvedSettings['targetAcos']!.value = 0.8;
    expect(() => method.evaluate(altered)).toThrow(/disagrees/);
  });
  it('freezes nested evaluator inputs without freezing the caller object', () => {
    const method = registerMethod(referenceDescriptor, (snapshot) => {
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.evidenceRows[0]?.metrics)).toBe(true);
      expect(() => { snapshot.methodParameters.targetAcos = 0.9; }).toThrow();
      return { kind: 'hold', hold: { reason: 'INSUFFICIENT_EVIDENCE', prose: 'Synthetic hold.', affectedScope: [request.entityRef], reconsiderWhen: 'Supply evidence.' } };
    });
    const snapshot = input();
    method.evaluate(snapshot);
    expect(Object.isFrozen(snapshot)).toBe(false);
    expect(snapshot.methodParameters.targetAcos).toBe(0.31);
  });
});
