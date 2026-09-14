/**
 * @wizard-ads/core (owned by WP-05).
 *
 * The doctrine engine: analyze, flags, pacing, recommendations, crosscheck,
 * campaign classification, n-grams, and White Box bidding. Pure functions with
 * ZERO I/O, ported from the Python reference tools with their selftests as
 * ground truth. It never imports `db` or `ads-api`, which is exactly what makes
 * the parity harness possible: an engine that can read a database cannot be
 * replayed against a golden.
 *
 * Doctrine VALUES are not here. Thresholds arrive as arguments; what lives in
 * this package is method.
 */
export const PACKAGE_NAME = '@wizard-ads/core' as const;

export * from './types.js';
export * from './num.js';
export * from './rows.js';
export * from './classify.js';
export * from './analyze.js';
export * from './flags.js';
export * from './pacing.js';
export * from './crosscheck.js';
export * from './recommendations.js';
export * from './experiments/backlog.js';
export * from './ngram.js';
export * from './bidding/index.js';
export * from './market/deals.js';
export * from './query-intelligence/index.js';
export * from './optimization/index.js';
export * from './methods/registry.js';
export { OPTIMIZATION_METHOD_CATALOGUE } from './methods/catalogue.js';
export * from './methods/reference.js';

export * from './market-position.js';
export { SP_COORDINATED_CAPABILITIES, spCoordinatedCapabilities } from './methods/capabilities.js';
export { coordinatedDescriptor } from './methods/coordinated.js';
export { resolveControlFeasibility } from './methods/control-feasibility.js';
export { coordinatedPlacementChange } from './methods/placement-change.js';
export * from './verdicts.js';
export * from './derived-columns.js';
export * from './bid-corridor.js';
