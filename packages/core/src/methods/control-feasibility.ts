import type { EntityRef, Hold } from '@wizard-ads/shared';
import { ceilToPrecision, floorToPrecision } from '../bidding/ceilings.js';

/** Intersect hard bounds on the supported two-decimal bid grid before choosing a bid. */
export function resolveControlFeasibility(input: {
  entityRef: EntityRef; currentBid: number; bidFloor: number; bidCeiling: number;
  maxIncrease: number; maxDecrease: number; exposureCeiling: number; maximumMultiplier: number;
}): { kind: 'feasible'; lower: number; upper: number; exposureUpper: number } | { kind: 'hold'; hold: Hold } {
  // A zero policy floor does not make zero a writable bid. The candidate verifies
  // two-decimal provider precision before passing its capability range here.
  const minimumPositiveBid = 10 ** -2;
  const lower = ceilToPrecision(Math.max(minimumPositiveBid, input.bidFloor, input.currentBid * (1 - input.maxDecrease)), 2);
  const exposureUpper = floorToPrecision(input.exposureCeiling / input.maximumMultiplier, 2);
  const upper = floorToPrecision(Math.min(input.bidCeiling, input.currentBid * (1 + input.maxIncrease), exposureUpper), 2);
  if (![lower, upper, exposureUpper].every(Number.isFinite) || input.maximumMultiplier < 1 || lower > upper || upper <= 0) {
    return { kind: 'hold', hold: {
      reason: 'NO_FEASIBLE_CONTROL_SET',
      prose: `The smallest positive supported bid, floor and reduction cap require a base of at least ${lower.toFixed(2)}; the ceiling, increase cap and exposure ceiling permit at most ${upper.toFixed(2)}. Exposure alone permits ${exposureUpper.toFixed(2)} (${input.exposureCeiling} / ${input.maximumMultiplier}). No base satisfies all hard bounds.`,
      affectedScope: [input.entityRef], reconsiderWhen: 'Review the conflicting limits or propose a separately bounded control set.',
    } };
  }
  return { kind: 'feasible', lower, upper, exposureUpper };
}
