import { SP_MARKETPLACE_MONEY_RULES } from '@wizard-ads/shared';
import { describe, expect, it } from 'vitest';
import { COORDINATED_METHOD, CoordinatedMethodParameters, CoordinatedMethodInput, ControlChange, DependencySet } from '@wizard-ads/shared';
import { coordinatedPlacementChange } from './placement-change.js';
import { resolveMethod } from './registry.js';
import { spCoordinatedCapabilities } from './capabilities.js';
import { maxPotentialCpc } from '../bidding/placement.js';
import { resolveControlFeasibility } from './control-feasibility.js';

// Chapter 8 fixtures are synthetic arithmetic examples, never tenant defaults.
const [marketplaceId, moneyRule] = Object.entries(SP_MARKETPLACE_MONEY_RULES).find(([, rule]) => rule.currencyCode === 'USD')!;
const marketplaceScope = { marketplaceId, region: moneyRule.region, currencyCode: moneyRule.currencyCode };
const marketplaceMin = Number(moneyRule.bidMin);
const profileId = '22222222-2222-4222-8222-222222222222';
function exampleOne(): CoordinatedMethodInput {
  return {
    runId: '11111111-1111-4111-8111-111111111111', profileId,
    methodId: COORDINATED_METHOD.id, methodVersion: COORDINATED_METHOD.version,
    window: { start: '2026-08-01', end: '2026-08-28' }, admittedAt: '2026-09-10T00:00:00Z',
    methodParameters: { targetAcos: 0.3, caps: { maxIncrease: 0.5, maxDecrease: 0.6 },
      floors: { manualMinBid: 0.1 }, ceilings: { manualMaxBid: 1 }, exposureCeiling: 1.5,
      minClicksPerPlacement: 20, placementEvidenceRequirements: 'single_target' },
    resolvedSettings: Object.fromEntries(Object.entries({ targetAcos: 0.3, bidFloor: 0.1, bidCeiling: 1,
      bidIncreaseCap: 0.5, bidDecreaseCap: 0.6, exposureCeiling: 1.5, minClicksPerPlacement: 20,
      placementEvidenceRequirements: 'single_target' }).map(([name, value]) => [name, { value, source: 'run', sourceLabel: 'Synthetic run' }])),
    evidenceRows: [{ entityRef: { profileId, campaignId: 'synthetic-campaign', entityId: 'synthetic-target', entityType: 'keyword', adProduct: 'SP' },
      adProduct: 'SP', currentBid: 0.6, metrics: { clicks: 100, sales: 260, orders: 10, cost: 90 },
      levels: { profile: { clicks: 100, sales: 260, orders: 10 } }, stock: { status: 'in_stock', asins: [] } }],
    campaignEvidence: { campaignId: 'synthetic-campaign', costType: 'cpc', complete: true,
      targetCount: 1, attributionMature: true, homogeneousProxyValidation: null,
      currentControls: { strategy: 'manual', placements: { topOfSearch: 100, restOfSearch: 0, productPages: 0, amazonBusiness: null },
        shopperCohorts: [], offAmazonBudgetControlStrategy: null },
      capabilities: spCoordinatedCapabilities(marketplaceScope),
      placementFacts: [
        { campaignId: 'synthetic-campaign', placement: 'top_of_search', clicks: 40, sales: 160, clickShare: 0.4 },
        { campaignId: 'synthetic-campaign', placement: 'rest_of_search', clicks: 40, sales: 80, clickShare: 0.4 },
        { campaignId: 'synthetic-campaign', placement: 'product_pages', clicks: 20, sales: 20, clickShare: 0.2 },
      ],
    },
  };
}
const evaluate = (input = exampleOne()) => resolveMethod(input.methodId, input.methodVersion).evaluate(input);
function lowRevenueExample(): CoordinatedMethodInput {
  const input = exampleOne();
  input.methodParameters.floors.manualMinBid = 0;
  input.resolvedSettings.bidFloor!.value = 0;
  input.methodParameters.caps.maxDecrease = 1;
  input.resolvedSettings.bidDecreaseCap!.value = 1;
  for (const target of input.evidenceRows) {
    target.metrics.sales /= 1000;
    target.levels.profile.sales /= 1000;
  }
  for (const fact of input.campaignEvidence.placementFacts) fact.sales /= 1000;
  return input;
}
describe('SP coordinated efficiency candidate', () => {
  it('reproduces Example 1 and preserves a safe three-step intervention', () => {
    const result = evaluate();
    expect(result.kind).toBe('proposal');
    if (result.kind !== 'proposal') throw new Error('Expected proposal');
    const values = Object.fromEntries(result.trace.steps.map((s) => [s.label, s.result]));
    expect(values).toMatchObject({ Z: 2.6, 'Target RPC: synthetic-target': 2.6, 'C: synthetic-target': 0.78,
      'Compensated base: synthetic-target': 0.3, 'Rounding: top_of_search': 300, 'Rounding: rest_of_search': 100,
      'Rounding: product_pages': 0, 'Weighted maximum: synthetic-target': 0.78, 'Economic gap: synthetic-target': 0 });
    expect(result.dependencySet?.changes.map((c) => [c.control, c.current, c.proposed])).toEqual([
      ['target_bid', 0.6, 0.3], ['placement_adjustment', 100, 300], ['placement_adjustment', 0, 100],
    ]);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]?.inputs.dependencySet).toEqual(result.dependencySet);
    expect(result.trace.steps.filter((s) => s.label.startsWith('Intermediate exposure:')).map((s) => s.result)).toEqual([0.6, 1.2, 1.2]);
    expect(result.dependencySet?.precedenceReasons).toHaveLength(2);
    let state = exampleOne().campaignEvidence.currentControls!;
    const providerChanges = result.dependencySet!.changes.flatMap((change) => {
      if (change.control !== 'placement_adjustment') return [];
      const placement = coordinatedPlacementChange(state, change);
      state = placement.requested; return [placement];
    });
    expect(providerChanges).toHaveLength(2);
    expect(providerChanges[1]?.expected).toEqual(providerChanges[0]?.requested);
    expect(providerChanges.map((change) => change.approvedPlacementKeys)).toEqual([['top_of_search'], ['rest_of_search']]);
    expect(resolveMethod(COORDINATED_METHOD.id, COORDINATED_METHOD.version).descriptor.releaseState).toBe('shadow');
  });
  it('reproduces Example 2: the exposure and reduction bounds cannot intersect', () => {
    const maximum = maxPotentialCpc({ baseBid: 0.4, placementModifiers: [{ name: 'TOS', pct: 100 }],
      audienceModifiers: [{ name: 'PURCH', pct: 50 }], biddingMode: 'auto_for_sales' });
    expect(maximum.multiplier).toBe(6);
    expect(maximum.value).toBeCloseTo(2.4, 12);
    const result = resolveControlFeasibility({ entityRef: exampleOne().evidenceRows[0]!.entityRef,
      marketplaceMin, marketplaceMax: Number(moneyRule.bidMax), decimalPlaces: moneyRule.scale,
      currentBid: 0.4, bidFloor: 0.1, bidCeiling: 1, maxIncrease: 0.5, maxDecrease: 0.1,
      exposureCeiling: 2, maximumMultiplier: maximum.multiplier });
    expect(result).toMatchObject({ kind: 'hold', hold: { reason: 'NO_FEASIBLE_CONTROL_SET' } });
    if (result.kind !== 'hold') throw new Error('Expected hold');
    expect(result.hold.prose).toContain('0.36');
    expect(result.hold.prose).toContain('0.33');
    expect(0.33 * maximum.multiplier).toBe(1.98);
    expect(0.36 * maximum.multiplier).toBe(2.16);
  });
  it('compounds TOS +235% with PURCH +50% as 5.03× displayed, retaining exact exposure', () => {
    const result = maxPotentialCpc({ baseBid: 1, placementModifiers: [{ name: 'TOS', pct: 235 }], audienceModifiers: [{ name: 'PURCH', pct: 50 }], biddingMode: 'manual' });
    expect(result.multiplier).toBe(5.025);
    expect(Number(result.multiplier.toFixed(2))).toBe(5.03);
    expect(result.value).toBe(5.025);
    expect(() => maxPotentialCpc({ baseBid: 1, audienceModifiers: [{ name: 'A', pct: 10 }, { name: 'B', pct: 20 }] })).toThrow(/overlap/);
  });
  it('holds when the Example 1 reduction cap conflicts with exposure', () => {
    const input = exampleOne(); input.methodParameters.caps.maxDecrease = 0.2; input.resolvedSettings.bidDecreaseCap!.value = 0.2;
    expect(evaluate(input)).toMatchObject({ kind: 'hold', hold: { reason: 'NO_FEASIBLE_CONTROL_SET' } });
  });
  it.each(['missing', 'currency', 'region', 'minimum', 'maximum', 'precision'] as const)(
    'holds an unverified marketplace capability: %s', (fault) => {
      const input = exampleOne();
      const marketplace = input.campaignEvidence.capabilities.marketplace!;
      if (fault === 'missing') delete input.campaignEvidence.capabilities.marketplace;
      else if (fault === 'currency') marketplace.currencyCode = 'XXX';
      else if (fault === 'region') marketplace.region = marketplace.region === 'EU' ? 'NA' : 'EU';
      else if (fault === 'minimum') marketplace.bidMin /= 2;
      else if (fault === 'maximum') marketplace.bidMax *= 2;
      else marketplace.decimalPlaces += 1;
      expect(evaluate(CoordinatedMethodInput.parse(input))).toMatchObject({ kind: 'hold', hold: { reason: 'INSUFFICIENT_EVIDENCE' } });
    },
  );
  it.each([{ minimum: 0, expected: marketplaceMin }, { minimum: 0.025, expected: 0.03 }])(
    'clamps valid low-revenue evidence to a positive representable bid (provider minimum $minimum)', ({ minimum, expected }) => {
      const input = lowRevenueExample();
      input.campaignEvidence.capabilities.entries.find((c) => c.control === 'target_bid')!.range!.min = minimum;
      const result = evaluate(CoordinatedMethodInput.parse(input));
      expect(result.kind).toBe('proposal');
      if (result.kind !== 'proposal') throw new Error('Expected positive bid proposal');
      const bid = result.dependencySet!.changes.find((c) => c.control === 'target_bid');
      expect(bid).toMatchObject({ control: 'target_bid', proposed: expected });
      expect(ControlChange.safeParse(bid).success).toBe(true);
      expect(result.trace.steps.find((s) => s.label === 'Joint bounds: synthetic-target')?.inputs)
        .toContainEqual({ name: 'lower', value: expected, unit: 'currency_per_click' });
    },
  );
  it.each(['exposure', 'bid_ceiling', 'capability_max', 'increase_cap'] as const)(
    'holds valid low-revenue evidence when %s leaves no positive representable bid', (bound) => {
      const input = lowRevenueExample();
      if (bound === 'exposure') {
        input.methodParameters.exposureCeiling = 0.039;
        input.resolvedSettings.exposureCeiling!.value = 0.039;
      } else if (bound === 'bid_ceiling') {
        input.methodParameters.ceilings.manualMaxBid = 0.009;
        input.resolvedSettings.bidCeiling!.value = 0.009;
      } else if (bound === 'capability_max') {
        input.campaignEvidence.capabilities.entries.find((c) => c.control === 'target_bid')!.range!.max = 0.009;
      } else {
        input.evidenceRows[0]!.currentBid = 0.005;
      }
      const result = evaluate(CoordinatedMethodInput.parse(input));
      expect(result).toMatchObject({ kind: 'hold', hold: { reason: 'NO_FEASIBLE_CONTROL_SET' } });
      if (result.kind !== 'hold') throw new Error('Expected representability hold');
      expect(result.hold.prose).toContain('at least ' + marketplaceMin.toFixed(moneyRule.scale));
      expect(result.hold.prose).toContain('at most 0.00');
    },
  );
  it('admits the smallest positive bid when it meets the exposure ceiling exactly', () => {
    const input = lowRevenueExample();
    input.methodParameters.exposureCeiling = marketplaceMin * 4;
    input.resolvedSettings.exposureCeiling!.value = marketplaceMin * 4;
    const result = evaluate(CoordinatedMethodInput.parse(input));
    expect(result.kind).toBe('proposal');
    if (result.kind !== 'proposal') throw new Error('Expected exact-bound proposal');
    expect(result.trace.steps.find((s) => s.label === 'Exposure: synthetic-target')?.result).toBe(marketplaceMin * 4);
    expect(result.dependencySet!.changes.find((c) => c.control === 'target_bid')?.proposed).toBe(marketplaceMin);
  });
  it('rejects missing evidence, unsupported proxy claims and zero baselines', () => {
    const input = exampleOne(); input.campaignEvidence.placementFacts[0]!.clicks = 0;
    expect(evaluate(input)).toMatchObject({ kind: 'hold', hold: { reason: 'INSUFFICIENT_EVIDENCE' } });
    const zero = exampleOne(); zero.campaignEvidence.placementFacts[2]!.sales = 0;
    expect(evaluate(zero)).toMatchObject({ kind: 'hold', hold: { reason: 'ZERO_BASELINE_RPC' } });
    const duplicate = exampleOne(); duplicate.evidenceRows.push(structuredClone(duplicate.evidenceRows[0]!));
    expect(evaluate(duplicate)).toMatchObject({ kind: 'hold', hold: { reason: 'INSUFFICIENT_EVIDENCE' } });
  });
  it('rounds within the integer matrix and binds changes and order in the stored set', () => {
    const input = exampleOne(); input.campaignEvidence.placementFacts[0]!.sales = 161.37;
    const result = evaluate(input);
    if (result.kind !== 'proposal') throw new Error('Expected proposal');
    const set = result.dependencySet!;
    for (const change of set.changes) expect(ControlChange.safeParse(change).success).toBe(true);
    const placement = set.changes.find((c) => c.control === 'placement_adjustment')!;
    expect(ControlChange.safeParse({ ...placement, proposed: 300.12 }).success).toBe(false);
    expect(ControlChange.safeParse({ ...placement, proposed: 901 }).success).toBe(false);
    expect(DependencySet.safeParse({ ...set, precedenceReasons: [] }).success).toBe(false);
    expect(DependencySet.parse(JSON.parse(JSON.stringify(set)))).toEqual(set);
  });
  it('requires supported bid capabilities, exclusive placements and positive economics', () => {
    const missing = exampleOne(); missing.campaignEvidence.capabilities.entries = missing.campaignEvidence.capabilities.entries.filter((c) => c.control !== 'target_bid');
    expect(evaluate(missing)).toMatchObject({ kind: 'hold', hold: { reason: 'INSUFFICIENT_EVIDENCE' } });
    const overlap = exampleOne(); overlap.campaignEvidence.capabilities.entries.find((c) => c.control === 'placement_adjustment')!.overlapRule = 'unknown';
    expect(evaluate(overlap)).toMatchObject({ kind: 'hold', hold: { reason: 'INSUFFICIENT_EVIDENCE' } });
    expect(CoordinatedMethodParameters.safeParse({ ...exampleOne().methodParameters, targetAcos: -0.3 }).success).toBe(false);
    const contradictory = exampleOne(); contradictory.resolvedSettings.targetAcos!.value = 0.99;
    expect(() => evaluate(contradictory)).toThrow('Resolved setting disagrees');
  });
  it.each([true, false])('orders the strongest reduction first and distinguishes target types (shared id: %s)', (sameId) => {
    const input = exampleOne(); const second = structuredClone(input.evidenceRows[0]!);
    second.entityRef.entityType = 'target'; second.entityRef.entityId = sameId ? second.entityRef.entityId : 'zz-bigger'; second.currentBid = 0.8;
    input.evidenceRows.push(second); input.campaignEvidence.targetCount = 2;
    input.campaignEvidence.homogeneousProxyValidation = 'Synthetic homogeneous validation';
    input.methodParameters.placementEvidenceRequirements = 'validated_homogeneous'; input.resolvedSettings.placementEvidenceRequirements!.value = 'validated_homogeneous';
    input.methodParameters.caps.maxDecrease = 0.8; input.resolvedSettings.bidDecreaseCap!.value = 0.8;
    const result = evaluate(input); if (result.kind !== 'proposal') throw new Error('Expected safe proposal');
    expect(result.dependencySet?.changes[0]?.entityRef).toEqual(second.entityRef);
    expect(result.trace.steps.filter((s) => s.label.startsWith('Intermediate exposure:')).map((s) => s.result)).toEqual([1.2, 0.6, 1.2, 1.2]);
  });

});
