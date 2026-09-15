import type { EntityRef, Hold } from '@wizard-ads/shared';
import { ceilToPrecision, floorToPrecision } from '../bidding/ceilings.js';

/** Intersect marketplace and policy bounds on the marketplace's writable bid grid. */
export function resolveControlFeasibility(input: {
  entityRef: EntityRef; currentBid: number; bidFloor: number; bidCeiling: number;
  maxIncrease: number; maxDecrease: number; exposureCeiling: number; maximumMultiplier: number;
  marketplaceMin: number; marketplaceMax: number; decimalPlaces: number;
}): { kind: 'feasible'; lower: number; upper: number; exposureUpper: number } | { kind: 'hold'; hold: Hold } {
  const precision = input.decimalPlaces;
  const lower = ceilToPrecision(Math.max(input.marketplaceMin, input.bidFloor, input.currentBid * (1 - input.maxDecrease)), precision);
  const exposureUpper = floorToPrecision(input.exposureCeiling / input.maximumMultiplier, precision);
  const upper = floorToPrecision(Math.min(input.marketplaceMax, input.bidCeiling, input.currentBid * (1 + input.maxIncrease), exposureUpper), precision);
  if (![lower, upper, exposureUpper].every(Number.isFinite) || input.maximumMultiplier < 1 || lower > upper || upper <= 0) {
    return { kind: 'hold', hold: {
      reason: 'NO_FEASIBLE_CONTROL_SET',
      prose: `The marketplace minimum, floor and reduction cap require a base of at least ${lower.toFixed(precision)}; the marketplace maximum, ceiling, increase cap and exposure ceiling permit at most ${upper.toFixed(precision)}. Exposure alone permits ${exposureUpper.toFixed(precision)} (${input.exposureCeiling} / ${input.maximumMultiplier}). No base satisfies all hard bounds.`,
      affectedScope: [input.entityRef], reconsiderWhen: 'Review the conflicting limits or propose a separately bounded control set.',
    } };
  }
  return { kind: 'feasible', lower, upper, exposureUpper };
}
