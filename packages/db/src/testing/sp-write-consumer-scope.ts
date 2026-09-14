/** Explicit WP-280 runtime consumers, shared by the persistence blast proofs. */
export const SP_WRITE_APPLICATION_CONSUMERS = [
  "apps/web/app/api/writes/approve/route.ts",
  "apps/web/app/api/writes/preview/route.ts",
  "apps/web/app/api/writes/status/route.ts",
  "apps/web/src/writes/approval-loader.ts",
  "apps/web/src/writes/approval-seed.ts",
  "apps/web/src/writes/http.ts"
] as const;
export const SP_WRITE_ACTIVATION_FILES = [
  // Reads outbox counts to prove Target 360 approval never enqueues execution.
  "apps/web/e2e/targets-queue.spec.ts",
  "apps/web/e2e/change-queue.spec.ts",
  "apps/web/app/api/writes/approve/route.ts",
  "apps/web/app/api/writes/preview/route.ts",
  "apps/web/app/api/writes/status/route.ts",
  "apps/web/src/writes/approval-loader.ts",
  "apps/web/src/writes/approval-seed.ts",
  "apps/web/src/writes/http.ts",
  "apps/worker/src/config.ts",
  "apps/worker/src/main.ts",
  "apps/worker/src/sp-write-outbox/artifacts.ts",
  "apps/worker/src/sp-write-outbox/composition.ts",
  "apps/worker/src/sp-write-outbox/guarded-provider-fetch.ts",
  "apps/worker/src/sp-write-outbox/loop.ts",
  "apps/worker/src/sp-write-outbox/live-smoke.ts",
  "apps/worker/src/sp-write-outbox/policy.ts",
  "apps/worker/src/sp-write-outbox/providers.ts",
  "apps/worker/src/store.ts"
] as const;
export const SP_WRITE_MIGRATIONS = [
  "20260901020000_sp_write_persistence_ledger.sql",
  "20260901030000_sp_write_outbox_delivery.sql",
  "20260915000000_sp_write_preview_evidence.sql",
  "20260915010000_sp_write_preview_approval.sql",
  "20260915020000_sp_write_application_entry.sql",
  "20260915030000_sp_write_mirror_observations.sql",
  "20260915040000_recommendation_proposal_revisions.sql",
  "20260915050000_mcp_write_delegation_mode.sql",
  "20260915060000_mcp_write_delegations.sql",
  "20260915070000_mcp_bid_proposal_sources.sql",
  "20260915080000_mcp_write_admissions.sql",
  "20260915090000_mcp_write_preview_sources.sql",
  "20260915100000_recommendation_fenced_function_acl.sql",
  "20260915110000_campaign_creation_previews.sql",
  "20260915130000_coordinated_methods.sql",
  "20260915170000_change_acknowledgements.sql"
] as const;
