import {
  COORDINATED_METHOD, DependencySet, spMarketplaceBidCapability, type CalculationStep, type CalculationTrace,
  type ControlChange, type MethodDescriptor, type MethodEvaluatorInput, type MethodEvaluatorOutput,
  type Recommendation, type HoldReason,
} from '@wizard-ads/shared';
import { maxPotentialCpc } from '../bidding/placement.js';
import { coordinatedPlacementChange } from './placement-change.js';
import { resolveControlFeasibility } from './control-feasibility.js';

export const coordinatedDescriptor: MethodDescriptor = {
  ...COORDINATED_METHOD, releaseState: 'draft', adProducts: ['SP'], controls: ['bid', 'placement'],
  placementEvaluator: 'coordinated', objectivePolicy: 'attributed_revenue_efficiency',
  requiredEvidence: ['target facts', 'campaign placement facts with click shares', 'complete campaign controls', 'placement proxy eligibility'],
};
const placementProperties = { top_of_search: 'topOfSearch', rest_of_search: 'restOfSearch', product_pages: 'productPages' } as const;

export function evaluateCoordinatedMethod(input: MethodEvaluatorInput): MethodEvaluatorOutput {
  if (input.methodId !== COORDINATED_METHOD.id || input.methodVersion !== COORDINATED_METHOD.version || !('campaignEvidence' in input)) throw new Error('Coordinated method identity mismatch');
  const { campaignEvidence: campaign, methodParameters: parameters, evidenceRows: targets } = input;
  const canonical = { targetAcos: parameters.targetAcos, bidFloor: parameters.floors.manualMinBid,
    bidCeiling: parameters.ceilings.manualMaxBid, bidIncreaseCap: parameters.caps.maxIncrease,
    bidDecreaseCap: parameters.caps.maxDecrease, exposureCeiling: parameters.exposureCeiling,
    minClicksPerPlacement: parameters.minClicksPerPlacement, placementEvidenceRequirements: parameters.placementEvidenceRequirements };
  for (const [name, value] of Object.entries(canonical)) {
    if (input.resolvedSettings[name]?.value !== value) throw new Error(`Resolved setting disagrees with method parameters: ${name}`);
  }
  const steps: CalculationStep[] = [];
  function step(label: string, formula: string, values: Record<string, number>, result: number | null, unit = 'ratio', boundApplied: CalculationStep['boundApplied'] = null) {
    const entry: CalculationStep = { index: steps.length, label, formula,
      inputs: Object.entries(values).map(([name, value]) => ({ name, value, unit: name === 'clicks' ? 'clicks' : name === 'sales' ? 'currency' : name === 'targetAcos' ? 'ratio' : unit })), intermediateValue: result, boundApplied, result };
    steps.push(entry);
    return entry;
  }
  function trace(): CalculationTrace {
    return { steps, finalResult: steps.at(-1)!.result, roundingStep: [...steps].reverse().find((s) => s.label.startsWith('Rounding:')) ?? steps[0]! };
  }
  function hold(reason: HoldReason, prose: string, reconsiderWhen: string): MethodEvaluatorOutput {
    step('Hold', reason, {}, null);
    return { kind: 'hold', hold: { reason, prose, affectedScope: targets.map((t) => t.entityRef), reconsiderWhen }, trace: trace() };
  }
  if (campaign.costType !== 'cpc' || targets.some((t) => t.adProduct !== 'SP')) {
    return hold('INSUFFICIENT_EVIDENCE', 'Coordinated efficiency requires Sponsored Products CPC evidence.', 'Select a compatible method and cost type.');
  }
  const controls = campaign.currentControls;
  if (controls === null) return hold('INSUFFICIENT_EVIDENCE', 'A complete synchronized campaign control snapshot is missing.', 'Synchronize all placement, audience and mode controls.');
  if (!campaign.attributionMature) return hold('ATTRIBUTION_INCOMPLETE', 'Placement or target attribution is incomplete.', 'Wait for mature attribution.');
  if (!campaign.complete || targets.length !== campaign.targetCount || new Set(targets.map((t) => `${t.entityRef.entityType}:${t.entityRef.entityId}`)).size !== targets.length
    || targets.some((t) => t.entityRef.campaignId !== campaign.campaignId || t.entityRef.profileId !== input.profileId)) {
    return hold('INSUFFICIENT_EVIDENCE', 'The evidence does not cover every affected target and active control in this campaign.', 'Supply complete campaign controls and target coverage.');
  }
  if (targets.length > 1 && (parameters.placementEvidenceRequirements === 'single_target' || campaign.homogeneousProxyValidation === null)) {
    return hold('MIXED_INTENT_PLACEMENT_PROXY', 'Campaign placement ratios need a validated homogeneous proxy before they can be applied to multiple targets.', 'Validate a representative homogeneous placement proxy or select a single-target campaign.');
  }
  if (targets.some((t) => t.stock?.status !== 'in_stock' || t.currentBid === null || t.currentBid <= 0 || t.metrics.clicks <= 0 || t.metrics.sales <= 0)) {
    return hold('INSUFFICIENT_EVIDENCE', 'Every affected target needs a positive synchronized bid, clicks and sales, and known in-stock eligibility.', 'Refresh complete target and stock evidence.');
  }
  const bidCapability = campaign.capabilities.entries.filter((c) => c.adProduct === 'SP' && c.costType === 'cpc' && c.control === 'target_bid');
  const bidCap = bidCapability[0];
  const marketplace = campaign.capabilities.marketplace;
  const verified = spMarketplaceBidCapability(marketplace ?? undefined);
  if (marketplace == null || verified === null || marketplace.bidMin !== verified.bidMin || marketplace.bidMax !== verified.bidMax
    || marketplace.decimalPlaces !== verified.decimalPlaces || marketplace.verifiedOn !== verified.verifiedOn) {
    return hold('INSUFFICIENT_EVIDENCE', 'The capability snapshot lacks verified marketplace bid limits for this currency and region.', 'Capture the profile marketplace capability.');
  }
  if (bidCapability.length !== 1 || !bidCap?.available || bidCap.unit !== 'currency_per_click'
    || bidCap.precision !== 'decimal' || bidCap.decimalPlaces !== marketplace.decimalPlaces || bidCap.range === null) {
    return hold('INSUFFICIENT_EVIDENCE', 'The capability snapshot lacks a supported target bid range and currency precision.', 'Verify target bid capability and currency precision.');
  }
  const required = Object.keys(placementProperties) as (keyof typeof placementProperties)[];
  const facts = required.map((placement) => campaign.placementFacts.find((f) => f.placement === placement));
  if (campaign.placementFacts.length !== required.length || facts.some((f) => f === undefined || f.campaignId !== campaign.campaignId || f.clicks < parameters.minClicksPerPlacement)) {
    return hold('INSUFFICIENT_EVIDENCE', 'Each of the three placements needs the configured minimum clicks, with no duplicate or missing placements.', 'Collect sufficient campaign × placement evidence.');
  }
  const placements = facts.map((f) => f!);
  const totalClicks = placements.reduce((sum, f) => sum + f.clicks, 0);
  if (placements.some((f) => Math.abs(f.clickShare - f.clicks / totalClicks) > 1e-10)) {
    return hold('INSUFFICIENT_EVIDENCE', 'Placement click shares do not reconcile with the supplied click counts.', 'Recompute shares from the same placement window.');
  }
  const rpcs = placements.map((f) => {
    const rpc = f.sales / f.clicks;
    step(`RPC: ${f.placement}`, 'sales / clicks', { sales: f.sales, clicks: f.clicks }, rpc, 'currency_per_click');
    return rpc;
  });
  const baseline = Math.min(...rpcs);
  step('Baseline RPC', 'min(placement RPC)', Object.fromEntries(required.map((key, i) => [key, rpcs[i]!])), baseline, 'currency_per_click');
  if (baseline <= 0) return hold('ZERO_BASELINE_RPC', 'The lowest placement RPC is zero; it cannot be used as a divisor.', 'Supply a positive, supported baseline without replacing zero evidence.');
  const proposedPlacements = placements.map((f, i) => {
    const ratio = rpcs[i]! / baseline;
    step(`Ratio: ${f.placement}`, 'placement RPC / baseline RPC', { rpc: rpcs[i]!, baseline }, ratio);
    const cap = campaign.capabilities.entries.find((c) => c.adProduct === 'SP' && c.costType === 'cpc' && c.control === 'placement_adjustment' && c.placementKey === f.placement);
    const raw = (ratio - 1) * 100;
    if (!cap?.available || cap.unit !== 'percentage' || cap.precision !== 'integer' || cap.decimalPlaces !== 0
      || cap.overlapRule !== 'exclusive' || cap.range === null || cap.range.max === null
      || !Number.isInteger(cap.range.min) || !Number.isInteger(cap.range.max) || cap.range.min < 0 || cap.range.max > 900) return null;
    const percentage = Math.max(cap.range.min, Math.min(cap.range.max, Math.round(raw)));
    step(`Rounding: ${f.placement}`, 'clamp(round((u - 1) × 100), provider range)', { ratio, raw, min: cap.range.min, max: cap.range.max }, percentage, 'percentage',
      { name: 'integer_percentage', value: percentage, before: raw, after: percentage });
    return { ...f, ratio, percentage };
  });
  if (proposedPlacements.some((p) => p === null)) return hold('INSUFFICIENT_EVIDENCE', 'The capability snapshot lacks a verified integer range for an affected placement.', 'Verify each required control capability.');
  const proposed = proposedPlacements.map((p) => p!);
  const z = placements.reduce((sum, p) => sum + p.sales, 0) / (totalClicks * baseline);
  step('Z', 'Σ(click share × RPC ratio) = total sales / (total clicks × baseline RPC)', Object.fromEntries(proposed.map((p) => [p.placement, p.clickShare * p.ratio])), z);
  if (controls.strategy === 'rule_based' || controls.placements.amazonBusiness !== null && controls.placements.amazonBusiness !== 0
    || controls.offAmazonBudgetControlStrategy !== null || controls.shopperCohorts.length > 1
    || required.some((key) => controls.placements[placementProperties[key]] === null)) {
    return hold('INSUFFICIENT_EVIDENCE', 'Current campaign controls include missing or unmodeled modifiers or audience overlap.', 'Capture and validate every active modifier and its overlap rule.');
  }
  const audiences = controls.shopperCohorts.map((c) => ({ name: c.shopperCohortType, pct: c.percentage }));
  const multiplier = maxPotentialCpc({ baseBid: 1, placementModifiers: proposed.map((p) => ({ name: p.placement, pct: p.percentage })),
    audienceModifiers: audiences, biddingMode: controls.strategy }).multiplier;
  step('Maximum exposure factor', 'max(placement factor) × audience factor × dynamic maximum', { multiplier }, multiplier);
  const changes: ControlChange[] = [];
  const bases = new Map<string, number>();
  const targetKey = (ref: ControlChange['entityRef']) => `${ref.entityType}:${ref.entityId}`;
  for (const target of targets) {
    const current = target.currentBid!;
    const feasible = resolveControlFeasibility({ entityRef: target.entityRef, currentBid: current,
      marketplaceMin: marketplace.bidMin, marketplaceMax: marketplace.bidMax, decimalPlaces: marketplace.decimalPlaces,
      bidFloor: Math.max(parameters.floors.manualMinBid, bidCap.range.min),
      bidCeiling: Math.min(parameters.ceilings.manualMaxBid, bidCap.range.max ?? Infinity),
      maxIncrease: parameters.caps.maxIncrease, maxDecrease: parameters.caps.maxDecrease,
      exposureCeiling: parameters.exposureCeiling, maximumMultiplier: multiplier });
    if (feasible.kind === 'hold') return hold(feasible.hold.reason, feasible.hold.prose, feasible.hold.reconsiderWhen);
    step(`Joint bounds: ${target.entityRef.entityId}`, 'intersection(marketplace bounds, floor, caps, ceiling, exposure)',
      { marketplaceMin: marketplace.bidMin, marketplaceMax: marketplace.bidMax, decimalPlaces: marketplace.decimalPlaces,
        lower: feasible.lower, upper: feasible.upper, exposureUpper: feasible.exposureUpper }, feasible.upper, 'currency_per_click');
    // The candidate normalization is calibrated only for fixed bidding without other boosts.
    if (controls.strategy !== 'manual' || audiences.some((a) => a.pct !== 0)) {
      return hold('INSUFFICIENT_EVIDENCE', 'The hard exposure bounds pass, but economic normalization for active audience or dynamic bidding factors is not validated.', 'Validate joint weights before extending this candidate beyond fixed bidding without audience boosts.');
    }
    const rpc = target.metrics.sales / target.metrics.clicks;
    step(`Target RPC: ${target.entityRef.entityId}`, 'target sales / target clicks', { sales: target.metrics.sales, clicks: target.metrics.clicks }, rpc, 'currency_per_click');
    const economic = parameters.targetAcos * rpc;
    step(`C: ${target.entityRef.entityId}`, 'target ACOS × target RPC', { targetAcos: parameters.targetAcos, rpc }, economic, 'currency_per_click');
    const rawBase = economic / z;
    step(`Compensated base: ${target.entityRef.entityId}`, 'C / Z', { C: economic, Z: z }, rawBase, 'currency_per_click');
    const scale = 10 ** marketplace.decimalPlaces;
    const base = Math.max(feasible.lower, Math.min(feasible.upper, Math.round(rawBase * scale) / scale));
    step(`Rounding: base ${target.entityRef.entityId}`, 'clamp(round(C / Z, currency precision), joint bounds)', { rawBase, lower: feasible.lower, upper: feasible.upper, decimalPlaces: marketplace.decimalPlaces }, base, 'currency_per_click',
      { name: 'joint_bounds_and_precision', value: base, before: rawBase, after: base });
    step(`Exposure: ${target.entityRef.entityId}`, 'rounded base × maximum factor', { base, multiplier }, base * multiplier, 'currency_per_click');
    if (base * multiplier > parameters.exposureCeiling + 1e-10) return hold('NO_FEASIBLE_CONTROL_SET', 'The rounded controls exceed the hard exposure ceiling.', 'Review the hard bounds.');
    const weighted = proposed.reduce((sum, p) => sum + p.clickShare * base * (1 + p.percentage / 100), 0);
    step(`Weighted maximum: ${target.entityRef.entityId}`, 'Σ(click share × rounded base × rounded placement factor)', { weighted, economic }, weighted, 'currency_per_click');
    step(`Economic gap: ${target.entityRef.entityId}`, 'weighted maximum − C', { weighted, C: economic }, weighted - economic, 'currency_per_click');
    bases.set(targetKey(target.entityRef), current);
    if (current !== base) changes.push({ control: 'target_bid', entityRef: target.entityRef, current, proposed: base, unit: 'currency_per_click' });
  }
  const campaignRef = { profileId: input.profileId, adProduct: 'SP' as const, entityType: 'campaign' as const, entityId: campaign.campaignId, campaignId: campaign.campaignId };
  for (const p of proposed) {
    const current = controls.placements[placementProperties[p.placement]]!;
    if (current !== p.percentage) changes.push({ control: 'placement_adjustment', entityRef: campaignRef, placementKey: p.placement, current, proposed: p.percentage, unit: 'percentage' });
  }
  if (changes.length === 0) return hold('GUARDRAIL_BLOCKED', 'The rounded control set already matches the synchronized configuration.', 'Re-evaluate when evidence or settings change.');
  const pending = [...changes];
  const ordered: ControlChange[] = [];
  let providerState = controls;
  const intermediatePlacements = Object.fromEntries(required.map((p) => [p, controls.placements[placementProperties[p]]!]));
  function exposureAfter(change: ControlChange): number {
    const nextBases = new Map(bases);
    const nextPlacements = { ...intermediatePlacements };
    if (change.control === 'target_bid') nextBases.set(targetKey(change.entityRef), change.proposed);
    if (change.control === 'placement_adjustment') nextPlacements[change.placementKey] = change.proposed;
    return Math.max(...nextBases.values()) * (1 + Math.max(...Object.values(nextPlacements)) / 100);
  }
  while (pending.length > 0) {
    // Choose the reduction with the lowest resulting exposure first. This also
    // permits repair of a currently excessive control without applying a weaker reduction first.
    pending.sort((a, b) => Number(a.proposed > a.current) - Number(b.proposed > b.current)
      || (a.proposed < a.current && b.proposed < b.current ? exposureAfter(a) - exposureAfter(b) : 0)
      || Number(a.control !== 'target_bid') - Number(b.control !== 'target_bid')
      || (a.control === 'placement_adjustment' && b.control === 'placement_adjustment'
        ? required.indexOf(a.placementKey as typeof required[number]) - required.indexOf(b.placementKey as typeof required[number]) : 0)
      || JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const change = pending.shift()!;
    const maximum = exposureAfter(change);
    const index = ordered.length + 1;
    step(`Intermediate exposure: step ${index}`, 'max(current intermediate base) × max(current intermediate placement factor)', { maximum, ceiling: parameters.exposureCeiling }, maximum, 'currency_per_click');
    if (maximum > parameters.exposureCeiling + 1e-10) return hold('NO_FEASIBLE_CONTROL_SET', `Step ${index} would expose ${maximum} above the ${parameters.exposureCeiling} ceiling.`, 'Choose a control set whose intermediate states satisfy the bound.');
    if (change.control === 'target_bid') bases.set(targetKey(change.entityRef), change.proposed);
    if (change.control === 'placement_adjustment') {
      providerState = coordinatedPlacementChange(providerState, change).requested;
      intermediatePlacements[change.placementKey] = change.proposed;
    }
    ordered.push(change);
  }
  const dependencySet = DependencySet.parse({ id: `${input.runId}:${campaign.campaignId}`, campaignId: campaign.campaignId, changes: ordered,
    precedenceReasons: ordered.slice(0, -1).map(() => 'Observe this step successfully before the next step; reductions must take effect before dependent increases.') });
  const savedTrace = trace();
  const recommendation: Recommendation = {
    runId: input.runId, profileId: input.profileId, entityRef: campaignRef, field: 'control_set',
    reason: 'high_acos', currentValue: null, proposedValue: null, status: 'proposed',
    inputs: { dependencySet, methodId: input.methodId, methodVersion: input.methodVersion, trace: savedTrace,
      settingSources: input.resolvedSettings, rpc: targets.reduce((n, t) => n + t.metrics.sales, 0) / targets.reduce((n, t) => n + t.metrics.clicks, 0),
      clicks: totalClicks, cvrSourceLevel: 'campaign', ceilingApplied: null, capClamped: false, window: input.window },
  };
  return { kind: 'proposal', changes: [recommendation], dependencySet, trace: savedTrace, dependencies: targets.map((t) => t.entityRef) };
}
