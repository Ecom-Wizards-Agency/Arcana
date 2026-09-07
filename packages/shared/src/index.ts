/**
 * `@wizard-ads/shared` is THE contract package.
 *
 * Rules, from AGENTS.md:
 *  - Schemas and inferred types only. No logic, no I/O, no dependency but zod.
 *  - Every shape that crosses a package boundary lives here.
 *  - Cross-package contracts land here before dependent implementations.
 *    Additive guarded-write and campaign-creation contracts are approved by
 *    the repository authority in AGENTS.md.
 */
export * from './primitives.js';
export * from './agency.js';
export * from './mcp-key-metadata.js';
export * from './amazon-connections.js';
export * from './integrations.js';
export * from './feedback.js';
export * from './experiments.js';
export * from './entities.js';
export * from './facts.js';
export * from './recommendations.js';
export * from './apply.js';
export * from './strategy.js';
export * from './jobs.js';
export * from './creative.js';
export * from './query-intelligence.js';
export * from './optimization.js';
export * from './one-time-optimization.js';
export * from './reporting.js';
export * from './unified-reporting.js';
export * from './dayparting.js';
export * from './campaign-creation.js';
export * from './tags.js';
export * from './recommendation-preview.js';
