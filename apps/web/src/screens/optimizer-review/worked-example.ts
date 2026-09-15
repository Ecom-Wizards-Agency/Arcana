import type { RecommendationRecord } from '@wizard-ads/db';
import { CalculationTrace, type CalculationStep, type DependencySet } from '@wizard-ads/shared';

/** Public, synthetic adaptation. These values are example inputs, never defaults. */
export const workedPlacementInputs = [
  { placement: 'Top of search', clicks: 30, revenue: 90, rpc: 3, clickShare: 30 / 72 },
  { placement: 'Rest of search', clicks: 30, revenue: 45, rpc: 1.5, clickShare: 30 / 72 },
  { placement: 'Product pages', clicks: 12, revenue: 9, rpc: 0.75, clickShare: 12 / 72 },
] as const;

const step = (index: number, label: string, formula: string, result: number, inputs: CalculationStep['inputs'] = [], boundApplied: CalculationStep['boundApplied'] = null): CalculationStep => ({ index, label, formula, result, inputs, intermediateValue: null, boundApplied });
const steps: CalculationStep[] = [
  step(0, 'Placement RPC', 'Top: 90 ÷ 30 = 3; rest: 45 ÷ 30 = 1.5; product pages: 9 ÷ 12 = 0.75', 0.75, workedPlacementInputs.flatMap((row) => [{ name: `${row.placement} clicks`, value: row.clicks, unit: 'clicks' }, { name: `${row.placement} revenue`, value: row.revenue, unit: 'USD' }])),
  step(1, 'Relative placement factors', 'Divide each RPC by 0.75: 4, 2, 1', 4, [{ name: 'Lowest placement RPC', value: 0.75, unit: 'USD per click' }]),
  step(2, 'Historical click shares', '30 ÷ 72; 30 ÷ 72; 12 ÷ 72', 1, [{ name: 'Total clicks', value: 72, unit: 'clicks' }]),
  step(3, 'Weighted relative factor', '(30 ÷ 72 × 4) + (30 ÷ 72 × 2) + (12 ÷ 72 × 1) = 8 ÷ 3', 8 / 3),
  step(4, 'Overall RPC', '(90 + 45 + 9) ÷ 72 = 2', 2, [{ name: 'Attributed revenue', value: 144, unit: 'USD' }]),
  step(5, 'Economic reference', '0.36 × 2 = 0.72', 0.72, [{ name: 'Group target ACOS', value: 0.36, unit: 'ratio' }, { name: 'Run target ACOS (overridden)', value: 0.29, unit: 'ratio' }]),
  step(6, 'Base bid and placement adjustments', '0.72 ÷ (8 ÷ 3) = 0.27; (4 − 1) × 100 = 300%; (2 − 1) × 100 = 100%', 0.27),
  step(7, 'Limits and safe ordering', '0.09 ≤ 0.27 ≤ 0.91; reduction 50% ≤ 58%; peak exposure 0.27 × 4 = 1.08 ≤ 1.31. Reduce the base before raising placements.', 0.27, [{ name: 'Bid floor', value: 0.09, unit: 'USD' }, { name: 'Bid ceiling', value: 0.91, unit: 'USD' }, { name: 'Maximum decrease', value: 0.58, unit: 'ratio' }, { name: 'Exposure ceiling', value: 1.31, unit: 'USD' }]),
  step(8, 'Rounding and exposure recheck', 'round(0.27, 2) = 0.27; maximum configured exposure = 1.08; weighted new maximum = 0.72', 0.27, [{ name: 'Bid precision', value: 2, unit: 'decimal places' }]),
];
export const workedPlacementTrace = CalculationTrace.parse({ steps, finalResult: 0.27, roundingStep: steps[8] });

const entityRef = { profileId: '22222222-2222-4222-8222-222222222222', entityType: 'keyword' as const, entityId: 'synthetic-placement-target', campaignId: 'synthetic-placement-campaign' };
export const workedDependencySet: DependencySet = {
  id: 'synthetic-placement-dependency', campaignId: entityRef.campaignId,
  changes: [
    { entityRef, control: 'target_bid', current: 0.54, proposed: 0.27, unit: 'currency_per_click' },
    { entityRef: { ...entityRef, entityType: 'campaign', entityId: entityRef.campaignId }, control: 'placement_adjustment', placementKey: 'top_of_search', current: 100, proposed: 300, unit: 'percentage' },
    { entityRef: { ...entityRef, entityType: 'campaign', entityId: entityRef.campaignId }, control: 'placement_adjustment', placementKey: 'rest_of_search', current: 0, proposed: 100, unit: 'percentage' },
  ],
  precedenceReasons: ['Reduce the base first so the search adjustment stays within the recorded exposure ceiling.', 'Retain the lower base before increasing the next placement.'],
};
export const workedPeakExposures = [0.54, 1.08, 1.08] as const;

export const workedPlacementRow: RecommendationRecord = {
  id: '33333333-3333-4333-8333-333333333333', runId: '44444444-4444-4444-8444-444444444444', orgId: '11111111-1111-4111-8111-111111111111', profileId: entityRef.profileId,
  reason: 'high_acos', entityType: 'keyword', entityId: entityRef.entityId, entityName: 'Synthetic placement target', adProduct: 'SP',
  campaignId: entityRef.campaignId, adGroupId: 'synthetic-placement-ad-group', campaignName: 'Synthetic placement campaign', adGroupName: 'Synthetic ad group', campaignPortfolioId: null, campaignKnown: true,
  field: 'bid', currentValue: 0.54, proposedValue: 0.27,
  inputs: { clicks: 72, rpc: 2, cvrSourceLevel: 'keyword', ceilingApplied: null, capClamped: false, methodId: 'sp.coordinated-efficiency', methodVersion: 'candidate.1', trace: workedPlacementTrace, dependencySet: workedDependencySet, window: { start: '2026-07-01', end: '2026-07-28' } },
  status: 'proposed', decidedBy: null, decidedAt: null, exportBatchId: null, exportBatchTag: null, decisionNote: null, createdAt: new Date('2026-07-30T00:00:00.000Z'),
};
