import { describe, expect, it } from 'vitest';
import type { MethodEvaluatorInput } from '@wizard-ads/shared';
import { referenceRows } from './render-fixture';
import { changeValue, goalLabel, money, recommendationReason } from './presentation';

const row = referenceRows[0]!;
const snapshot: MethodEvaluatorInput = {
  runId: row.runId, profileId: row.profileId, admittedAt: '2026-07-30T00:00:00.000Z',
  methodId: 'sp.reference-efficiency', methodVersion: 'reference.1', window: row.inputs.window!,
  resolvedSettings: { targetAcos: { value: .37, source: 'group', sourceLabel: 'Assigned group' } },
  methodParameters: { targetAcos: .37, caps: { maxIncrease: .23, maxDecrease: .41 } },
  evidenceRows: [{ entityRef: { profileId: row.profileId, entityType: 'keyword', entityId: row.entityId, campaignId: row.campaignId! },
    adProduct: 'SP', currentBid: .54, metrics: { cost: 67, sales: 100, clicks: 72, orders: 5 },
    levels: { profile: { clicks: 72, sales: 100, orders: 5 } } }],
};
describe('saved optimizer presentation', () => {
  it('uses recorded target evidence and its resolved ACOS source', () => {
    expect(recommendationReason(row, [snapshot])).toBe('ACOS 67% against a 37% target');
    expect(recommendationReason(row, [{ ...snapshot, methodParameters: { ...snapshot.methodParameters, targetAcos: .29 } }])).toBe('ACOS 67% against a 37% target');
  });
  it('uses prose when figures are absent, mismatched or ambiguous', () => {
    for (const snapshots of [[], [snapshot, snapshot], [{ ...snapshot, runId: 'unrelated-run' }], [{ ...snapshot, resolvedSettings: {} }]]) {
      expect(recommendationReason(row, snapshots)).toBe('ACOS above target');
    }
    expect(recommendationReason({ ...row, reason: 'high_spend_no_sales' })).toBe('Spend without sales');
  });
  it('formats money without changing absent values or percentage controls into currency', () => {
    expect(money('0.87', 'USD')).toBe('$0.87');
    expect(money(null, 'USD')).toBe('Unavailable');
    expect(money(null, 'USD', 'Not set')).toBe('Not set');
    expect(money('', 'USD')).toBe('Unavailable');
    expect(changeValue({ amount: '0.69', currencyCode: 'USD' }, 'bid', 'USD')).toBe('$0.69');
    expect(changeValue(100, 'placement_adjustment', 'USD')).toBe('100%');
    expect(goalLabel('rank')).toBe('Organic growth');
    expect(goalLabel('profit')).toBe('Profit');
    expect(goalLabel(null)).toBe('No saved goal');
  });
});
