/** Public export inventory. generatedBarrels is pure; the caller owns file I/O. */
export const PACKAGE_REGISTRY = [
  { module: "./stream-consumer.js", clause: "*" },
  { module: "./asset-eligibility.js", clause: "*" },
  { module: "./provider-graph.js", clause: "*" },
  {
    "module": "./types.js",
    "clause": "*"
  },
  {
    "module": "./num.js",
    "clause": "*"
  },
  {
    "module": "./rows.js",
    "clause": "*"
  },
  {
    "module": "./classify.js",
    "clause": "*"
  },
  {
    "module": "./analyze.js",
    "clause": "*"
  },
  {
    "module": "./flags.js",
    "clause": "*"
  },
  {
    "module": "./pacing.js",
    "clause": "*"
  },
  {
    "module": "./crosscheck.js",
    "clause": "*"
  },
  {
    "module": "./recommendations.js",
    "clause": "*"
  },
  {
    "module": "./experiments/backlog.js",
    "clause": "*"
  },
  {
    "module": "./ngram.js",
    "clause": "*"
  },
  {
    "module": "./bidding/index.js",
    "clause": "*"
  },
  {
    "module": "./market/deals.js",
    "clause": "*"
  },
  {
    "module": "./query-intelligence/index.js",
    "clause": "*"
  },
  {
    "module": "./optimization/index.js",
    "clause": "*"
  },
  {
    "module": "./methods/registry.js",
    "clause": "*"
  },
  {
    "module": "./methods/catalogue.js",
    "clause": "{ OPTIMIZATION_METHOD_CATALOGUE }"
  },
  {
    "module": "./methods/reference.js",
    "clause": "*"
  },
  {
    "module": "./market-position.js",
    "clause": "*"
  },
  {
    "module": "./methods/capabilities.js",
    "clause": "{ SP_COORDINATED_CAPABILITIES, spCoordinatedCapabilities }"
  },
  {
    "module": "./methods/coordinated.js",
    "clause": "{ coordinatedDescriptor }"
  },
  {
    "module": "./methods/control-feasibility.js",
    "clause": "{ resolveControlFeasibility }"
  },
  {
    "module": "./methods/placement-change.js",
    "clause": "{ coordinatedPlacementChange }"
  },
  {
    "module": "./verdicts.js",
    "clause": "*"
  },
  {
    "module": "./derived-columns.js",
    "clause": "*"
  },
  {
    "module": "./bid-corridor.js",
    "clause": "*"
  },
  {
    "module": "./timeline-effect.js",
    "clause": "{ timelineDates, timelineSummary, timelineValue, timelineEffect, timelinePretrend, shiftTimelineDate }"
  },
  {
    "module": "./creative/performance.js",
    "clause": "*"
  },
  {
    "module": "./creative/certainty.js",
    "clause": "*"
  },
  {
    "module": "./creative/prompt-loop.js",
    "clause": "*"
  },
  {
    "module": "./campaign-builder/bid.js",
    "clause": "{ calculateCampaignStartingBid, campaignBidRationale }"
  },
  {
    "module": "./campaign-builder/eligibility.js",
    "clause": "{ campaignBuilderEligibility }"
  }
] as const;

const header = "/**\n * @wizard-ads/core (owned by WP-05).\n *\n * The doctrine engine: analyze, flags, pacing, recommendations, crosscheck,\n * campaign classification, n-grams, and White Box bidding. Pure functions with\n * ZERO I/O, ported from the Python reference tools with their selftests as\n * ground truth. It never imports `db` or `ads-api`, which is exactly what makes\n * the parity harness possible: an engine that can read a database cannot be\n * replayed against a golden.\n *\n * Doctrine VALUES are not here. Thresholds arrive as arguments; what lives in\n * this package is method.\n */\nexport const PACKAGE_NAME = '@wizard-ads/core' as const;\n\n";
export function generatedBarrels(): Record<string, string> {
  return { "index.ts": header + PACKAGE_REGISTRY.map(({ clause, module }) => `export ${clause} from '${module}';`).join("\n") + "\n" };
}
