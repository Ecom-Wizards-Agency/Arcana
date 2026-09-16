/** Package inventory, including internal and implementation-bearing subpaths.
 * Only explicitly listed re-exports enter generated facades; an empty exports list
 * does not widen the package root. Order and trailing prose belong to each export.
 */
interface RegistryEntry {
  domain: string;
  contract: string | null;
  schema: string | null;
  queries: string | null;
  migrationPrefix: string | null;
  exports: readonly { barrel: string; order: number; clause: string; after: string }[];
}
export const PACKAGE_REGISTRY: readonly RegistryEntry[] = [
  {domain: 'schema/report-families', contract: null, schema: 'schema/report-families.ts', queries: null, migrationPrefix: '20260915330000', exports: [{barrel: 'schema/index.ts', order: 120, clause: '*', after: ''}]},
  {domain: 'queries/report-families', contract: null, schema: null, queries: 'queries/report-families.ts', migrationPrefix: '20260915330000', exports: [{barrel: 'index.ts', order: 120, clause: '*', after: ''}]},
  {"domain":"queries/grid-performance-evidence","contract":null,"schema":null,"queries":"queries/grid-performance-evidence.ts","migrationPrefix":null,"exports":[{"barrel":"index.ts","order":121,"clause":"*","after":""}]},
  {"domain": "schema/spapi-reports", "contract": null, "schema": "schema/spapi-reports.ts", "queries": null, "migrationPrefix": "20260915320000", "exports": [{"barrel": "schema/index.ts", "order": 120, "clause": "*", "after": ""}]},
  {"domain": "queries/spapi-reports", "contract": null, "schema": null, "queries": "queries/spapi-reports.ts", "migrationPrefix": "20260915320000", "exports": [{"barrel": "index.ts", "order": 120, "clause": "*", "after": ""}]},
  {domain: "queries/sp-write-application-optimizer", contract: null, schema: null, queries: "queries/sp-write-application-optimizer.ts", migrationPrefix: null, exports: [{barrel: "index.ts", order: 106, clause: "{ prepareOptimizerRetry, readOptimizerRetryExclusions }", after: ""}]},
  {domain: "queries/optimizer-export", contract: null, schema: null, queries: "queries/optimizer-export.ts", migrationPrefix: "20260915190000", exports: [{barrel: "index.ts", order: 105, clause: "*", after: ""}]},
  {"domain": "queries/optimizer-run", "contract": null, "schema": null, "queries": "queries/optimizer-run.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 104, "clause": "*", "after": ""}]},
  {"domain": "queries/optimization-group-performance", "contract": null, "schema": null, "queries": "queries/optimization-group-performance.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 103, "clause": "*", "after": ""}]},
  {"domain": "queries/creative-workspace", "contract": null, "schema": null, "queries": "queries/creative-workspace.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 103, "clause": "*", "after": ""}]},
  {"domain": "queries/creative-change-history", "contract": null, "schema": null, "queries": "queries/creative-change-history.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 104, "clause": "*", "after": ""}]},
  {"domain": "queries/sponsored-prompts", "contract": null, "schema": null, "queries": "queries/sponsored-prompts.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 105, "clause": "*", "after": ""}]},
  {"domain": "schema/sponsored-prompts", "contract": null, "schema": "schema/sponsored-prompts.ts", "queries": null, "migrationPrefix": "20260915220000", "exports": [{"barrel": "schema/index.ts", "order": 103, "clause": "*", "after": ""}]},
  {"domain": "schema/creative-observations", "contract": null, "schema": "schema/creative-observations.ts", "queries": null, "migrationPrefix": "20260915230000", "exports": [{"barrel": "schema/index.ts", "order": 104, "clause": "*", "after": ""}]},
  { domain: 'queries/ad-group-products', contract: null, schema: null, queries: 'queries/ad-group-products.ts', migrationPrefix: null, exports: [{ barrel: 'index.ts', order: 103, clause: '*', after: '' }] },
  { domain: 'schema/ad-group-products', contract: null, schema: 'schema/ad-group-products.ts', queries: null, migrationPrefix: '20260915260000', exports: [{ barrel: 'schema/index.ts', order: 103, clause: '*', after: '' }] },
  {"domain":"asset-library","contract":null,"schema":null,"queries":"queries/asset-library.ts","migrationPrefix":null,"exports":[{"barrel":"index.ts","order":203,"clause":"*","after":""}]},
  {"domain":"schema/asset-library","contract":null,"schema":"schema/asset-library.ts","queries":null,"migrationPrefix":"20260915250000","exports":[{"barrel":"schema/index.ts","order":201,"clause":"*","after":""}]},
  {"domain":"campaign-drafts","contract":null,"schema":null,"queries":"queries/campaign-drafts.ts","migrationPrefix":null,"exports":[{"barrel":"index.ts","order":200,"clause":"*","after":""}]},
  {"domain":"naming-presets","contract":null,"schema":null,"queries":"queries/naming-presets.ts","migrationPrefix":null,"exports":[{"barrel":"index.ts","order":201,"clause":"*","after":""}]},
  {"domain":"keyword-sets","contract":null,"schema":null,"queries":"queries/keyword-sets.ts","migrationPrefix":null,"exports":[{"barrel":"index.ts","order":202,"clause":"*","after":""}]},
  {"domain":"schema/campaign-builder","contract":null,"schema":"schema/campaign-builder.ts","queries":null,"migrationPrefix":"20260915240000","exports":[{"barrel":"schema/index.ts","order":200,"clause":"*","after":""}]},
  {domain:"schema/research",contract:null,schema:"schema/research.ts",queries:null,migrationPrefix:"20260915200000",exports:[{barrel:"schema/index.ts",order:103,clause:"*",after:""}]},
  {domain:"queries/brand-lens",contract:null,schema:null,queries:"queries/brand-lens.ts",migrationPrefix:null,exports:[{barrel:"index.ts",order:103,clause:"*",after:""}]},
  {domain:"queries/dayparting-schedules",contract:null,schema:null,queries:"queries/dayparting-schedules.ts",migrationPrefix:null,exports:[{barrel:"index.ts",order:104,clause:"*",after:""}]},
  {"domain": "queries/timeline", "contract": null, "schema": null, "queries": "queries/timeline.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 102, "clause": "*", "after": ""}]},
  {"domain": "schema/timeline-events", "contract": null, "schema": "schema/timeline-events.ts", "queries": null, "migrationPrefix": "20260915180000", "exports": [{"barrel": "schema/index.ts", "order": 102, "clause": "*", "after": ""}]},
  {"domain": "schema/target-translations", "contract": null, "schema": "schema/target-translations.ts", "queries": null, "migrationPrefix": "20260915150000", "exports": [{"barrel": "schema/index.ts", "order": 101, "clause": "*", "after": ""}]},
  {"domain": "queries/translation", "contract": null, "schema": null, "queries": "queries/translation.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 101, "clause": "*", "after": ""}]},
  {"domain": "schema/market-position", "contract": null, "schema": "schema/market-position.ts", "queries": null, "migrationPrefix": null, "exports": [{"barrel": "schema/index.ts", "order": 100, "clause": "*", "after": ""}]},
  {"domain": "queries/market-position", "contract": null, "schema": null, "queries": "queries/market-position.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 100, "clause": "*", "after": ""}]},
  {domain: "queries/sp-write-restore-preview", contract: null, schema: null, queries: "queries/sp-write-restore-preview.ts", migrationPrefix: null, exports: [{barrel: "index.ts", order: 91, clause: "{ buildRestoreProposal, readRestoreProposal, reviewRestoreProposal }", after: ""}]},
  {domain: "schema/restore-proposals", contract: null, schema: "schema/restore-proposals.ts", queries: null, migrationPrefix: "20260915170000", exports: [{barrel: "schema/index.ts", order: 91, clause: "*", after: ""}]},
  {domain: "queries/queued-changes", contract: null, schema: null, queries: "queries/queued-changes.ts", migrationPrefix: null, exports: [{barrel: "index.ts", order: 90, clause: "*", after: ""}]},
  {domain: "schema/queued-changes", contract: null, schema: "schema/queued-changes.ts", queries: null, migrationPrefix: "20260915160000", exports: [{barrel: "schema/index.ts", order: 90, clause: "*", after: ""}]},
  {"domain": "campaign-creation-previews", "contract": null, "schema": null, "queries": "campaign-creation-previews.ts", "migrationPrefix": null, "exports": []},
  {"domain": "client", "contract": null, "schema": null, "queries": "client.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 0, "clause": "*", "after": ""}]},
  {"domain": "mcp-writes", "contract": null, "schema": null, "queries": "mcp-writes.ts", "migrationPrefix": null, "exports": []},
  {"domain": "operator", "contract": null, "schema": null, "queries": "operator.ts", "migrationPrefix": null, "exports": []},
  {"domain": "queries/agency-bootstrap", "contract": null, "schema": null, "queries": "queries/agency-bootstrap.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 2, "clause": "*", "after": ""}]},
  {"domain": "queries/agency-provisioning", "contract": null, "schema": null, "queries": "queries/agency-provisioning.ts", "migrationPrefix": null, "exports": [{"barrel": "operator.ts", "order": 0, "clause": "*", "after": ""}]},
  {"domain": "queries/amazon-connection-operations", "contract": null, "schema": null, "queries": "queries/amazon-connection-operations.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 3, "clause": "*", "after": ""}]},
  {"domain": "queries/amazon-connection-worker", "contract": null, "schema": null, "queries": "queries/amazon-connection-worker.ts", "migrationPrefix": null, "exports": [{"barrel": "worker.ts", "order": 1, "clause": "*", "after": ""}]},
  {"domain": "queries/apply-state", "contract": null, "schema": null, "queries": "queries/apply-state.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 35, "clause": "*", "after": ""}]},
  {"domain": "queries/authenticated-actor", "contract": null, "schema": null, "queries": "queries/authenticated-actor.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 1, "clause": "*", "after": ""}]},
  {"domain": "queries/bid-series", "contract": null, "schema": null, "queries": "queries/bid-series.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 17, "clause": "*", "after": ""}]},
  {"domain": "queries/campaign-creation-previews", "contract": null, "schema": null, "queries": "queries/campaign-creation-previews.ts", "migrationPrefix": null, "exports": [{"barrel": "campaign-creation-previews.ts", "order": 0, "clause": "{ recordCampaignCreationPreview, readRecordedCampaignCreationPreview,\n  CampaignCreationPreviewError }", "after": ""}]},
  {"domain": "queries/campaign-update", "contract": null, "schema": null, "queries": "queries/campaign-update.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 7, "clause": "*", "after": ""}]},
  {"domain": "queries/chunk", "contract": null, "schema": null, "queries": "queries/chunk.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 6, "clause": "*", "after": ""}]},
  {"domain": "queries/connections", "contract": null, "schema": null, "queries": "queries/connections.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 12, "clause": "*", "after": ""}]},
  {"domain": "queries/contextual-negative-review", "contract": null, "schema": null, "queries": "queries/contextual-negative-review.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 13, "clause": "*", "after": ""}]},
  {"domain": "queries/creative-performance", "contract": null, "schema": null, "queries": "queries/creative-performance.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 8, "clause": "*", "after": ""}]},
  {"domain": "queries/creative-pilot-preflight", "contract": null, "schema": null, "queries": "queries/creative-pilot-preflight.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 9, "clause": "*", "after": ""}]},
  {"domain": "queries/creative-sync-producer", "contract": null, "schema": null, "queries": "queries/creative-sync-producer.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 10, "clause": "*", "after": ""}]},
  {"domain": "queries/dayparting", "contract": null, "schema": null, "queries": "queries/dayparting.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 11, "clause": "*", "after": ""}]},
  {"domain": "queries/economics", "contract": null, "schema": null, "queries": "queries/economics.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 18, "clause": "*", "after": ""}]},
  {"domain": "queries/entities", "contract": null, "schema": null, "queries": "queries/entities.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 14, "clause": "*", "after": ""}]},
  {"domain": "queries/experiments", "contract": null, "schema": null, "queries": "queries/experiments.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 15, "clause": "*", "after": ""}]},
  {"domain": "queries/facts", "contract": null, "schema": null, "queries": "queries/facts.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 16, "clause": "*", "after": ""}]},
  {"domain": "queries/feedback", "contract": null, "schema": null, "queries": "queries/feedback.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 19, "clause": "*", "after": ""}]},
  {"domain": "queries/freshness", "contract": null, "schema": null, "queries": "queries/freshness.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 44, "clause": "{ readProfileFreshness }", "after": ""}]},
  {"domain": "queries/goto", "contract": null, "schema": null, "queries": "queries/goto.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 20, "clause": "*", "after": ""}]},
  {"domain": "queries/grid-views", "contract": null, "schema": null, "queries": "queries/grid-views.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 46, "clause": "*", "after": ""}]},
  {"domain": "queries/integrations", "contract": null, "schema": null, "queries": "queries/integrations.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 21, "clause": "{\n  IntegrationSecretStoreError,\n  IntegrationCredentialCommandError,\n  connectIntegrationCredentialForActor,\n  revokeIntegrationCredentialForActor,\n  createIntegrationConnection,\n  listIntegrationConnections,\n  revokeIntegrationSecret,\n  setIntegrationConnectionStatus,\n  storeIntegrationSecret,\n}", "after": ""}, {"barrel": "index.ts", "order": 22, "clause": "type {\n  CreateIntegrationConnectionInput,\n  IntegrationConnectionRecord,\n  IntegrationConnectionStatus,\n  IntegrationProvider,\n  IntegrationQueryHandle,\n  SetIntegrationConnectionStatusInput,\n}", "after": ""}, {"barrel": "worker.ts", "order": 0, "clause": "{ getIntegrationSecret }", "after": ""}]},
  {"domain": "queries/job-wire", "contract": null, "schema": null, "queries": "queries/job-wire.ts", "migrationPrefix": null, "exports": []},
  {"domain": "queries/jobs", "contract": null, "schema": null, "queries": "queries/jobs.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 23, "clause": "*", "after": ""}]},
  {"domain": "queries/keepa", "contract": null, "schema": null, "queries": "queries/keepa.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 24, "clause": "*", "after": ""}]},
  {"domain": "queries/control-mirror", "contract": null, "schema": null, "queries": "queries/control-mirror.ts", "migrationPrefix": null, "exports": [{"barrel": "sp-write-worker.ts", "order": 4, "clause": "{ mergeControlMirror }", "after": ""}]},
  {"domain": "queries/keyword-mirror", "contract": null, "schema": null, "queries": "queries/keyword-mirror.ts", "migrationPrefix": null, "exports": [{"barrel": "sp-write-worker.ts", "order": 2, "clause": "{ mergeKeywordMirror, readKeywordMirrorStart }", "after": ""}]},
  {"domain": "queries/mcp-key-commands", "contract": null, "schema": null, "queries": "queries/mcp-key-commands.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 39, "clause": "*", "after": "\n"}]},
  {"domain": "queries/mcp-key-metadata", "contract": null, "schema": null, "queries": "queries/mcp-key-metadata.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 38, "clause": "*", "after": ""}]},
  {"domain": "queries/mcp-write-application", "contract": null, "schema": null, "queries": "queries/mcp-write-application.ts", "migrationPrefix": null, "exports": [{"barrel": "mcp-writes.ts", "order": 1, "clause": "{ previewMcpBidChanges, applyMcpBidChanges, readMcpWriteStatus }", "after": ""}]},
  {"domain": "queries/mcp-write-preview", "contract": null, "schema": null, "queries": "queries/mcp-write-preview.ts", "migrationPrefix": null, "exports": []},
  {"domain": "queries/mcp-writes", "contract": null, "schema": null, "queries": "queries/mcp-writes.ts", "migrationPrefix": null, "exports": [{"barrel": "mcp-writes.ts", "order": 0, "clause": "{ issueMcpWriteDelegation, listMcpWriteDelegations, revokeMcpKeyAsOperator }", "after": "\n"}]},
  {"domain": "queries/optimization-groups", "contract": null, "schema": null, "queries": "queries/optimization-groups.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 27, "clause": "*", "after": ""}]},
  {"domain": "queries/partitions", "contract": null, "schema": null, "queries": "queries/partitions.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 25, "clause": "*", "after": ""}]},
  {"domain": "queries/pg-time", "contract": null, "schema": null, "queries": "queries/pg-time.ts", "migrationPrefix": null, "exports": []},
  {"domain": "queries/privileged-actor", "contract": null, "schema": null, "queries": "queries/privileged-actor.ts", "migrationPrefix": null, "exports": [{"barrel": "worker.ts", "order": 2, "clause": "{ lockPrivilegedOrgEditor }", "after": ""}]},
  {"domain": "queries/profiles", "contract": null, "schema": null, "queries": "queries/profiles.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 26, "clause": "*", "after": ""}]},
  {"domain": "queries/query-intelligence-authority", "contract": null, "schema": null, "queries": "queries/query-intelligence-authority.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 43, "clause": "*", "after": ""}]},
  {"domain": "queries/recommendation-readiness", "contract": null, "schema": null, "queries": "queries/recommendation-readiness.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 29, "clause": "*", "after": ""}]},
  {"domain": "queries/recommendation-revisions", "contract": null, "schema": null, "queries": "queries/recommendation-revisions.ts", "migrationPrefix": null, "exports": []},
  {"domain": "queries/recommendations", "contract": null, "schema": null, "queries": "queries/recommendations.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 28, "clause": "*", "after": ""}]},
  {"domain": "queries/recommendations-authority", "contract": null, "schema": null, "queries": "queries/recommendations-authority.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 42, "clause": "*", "after": ""}]},
  {"domain": "queries/report-coverage", "contract": null, "schema": null, "queries": "queries/report-coverage.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 45, "clause": "{ upsertReportCoverage, recordReportCoverage, backfillReportCoverage }", "after": ""}]},
  {"domain": "queries/report-lifecycle", "contract": null, "schema": null, "queries": "queries/report-lifecycle.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 40, "clause": "*", "after": ""}]},
  {"domain": "queries/report-promotion", "contract": null, "schema": null, "queries": "queries/report-promotion.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 30, "clause": "*", "after": ""}]},
  {"domain": "queries/report-reconciliation", "contract": null, "schema": null, "queries": "queries/report-reconciliation.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 41, "clause": "*", "after": ""}]},
  {"domain": "queries/request-client", "contract": null, "schema": null, "queries": "queries/request-client.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 37, "clause": "*", "after": "\n"}]},
  {"domain": "queries/sp-write-approval", "contract": null, "schema": null, "queries": "queries/sp-write-approval.ts", "migrationPrefix": null, "exports": []},
  {"domain": "queries/sp-write-commands", "contract": null, "schema": null, "queries": "queries/sp-write-commands.ts", "migrationPrefix": null, "exports": [{"barrel": "sp-write-application.ts", "order": 1, "clause": "*", "after": ""}]},
  {"domain": "queries/sp-write-errors", "contract": null, "schema": null, "queries": "queries/sp-write-errors.ts", "migrationPrefix": null, "exports": [{"barrel": "sp-write-application.ts", "order": 0, "clause": "{ SpWriteApplicationError }", "after": ""}]},
  {"domain": "queries/sp-write-inverse-preview", "contract": null, "schema": null, "queries": "queries/sp-write-inverse-preview.ts", "migrationPrefix": null, "exports": []},
  {"domain": "queries/sp-write-mirror", "contract": null, "schema": null, "queries": "queries/sp-write-mirror.ts", "migrationPrefix": null, "exports": [{"barrel": "sp-write-worker.ts", "order": 1, "clause": "{ reconcileSpWriteObservation }", "after": ""}]},
  {"domain": "queries/sp-write-operation-read", "contract": null, "schema": null, "queries": "queries/sp-write-operation-read.ts", "migrationPrefix": null, "exports": []},
  {"domain": "queries/sp-write-persistence", "contract": null, "schema": null, "queries": "queries/sp-write-persistence.ts", "migrationPrefix": null, "exports": [{"barrel": "sp-write-worker.ts", "order": 3, "clause": "{ settleSpWriteDependencies }", "after": ""}, {"barrel": "sp-write-persistence.ts", "order": 0, "clause": "*", "after": ""}]},
  {"domain": "queries/sp-write-plan-builder", "contract": null, "schema": null, "queries": "queries/sp-write-plan-builder.ts", "migrationPrefix": null, "exports": []},
  {"domain": "queries/sp-write-preview-evidence", "contract": null, "schema": null, "queries": "queries/sp-write-preview-evidence.ts", "migrationPrefix": null, "exports": []},
  {"domain": "queries/sp-write-recorded-preview", "contract": null, "schema": null, "queries": "queries/sp-write-recorded-preview.ts", "migrationPrefix": null, "exports": []},
  {"domain": "queries/sp-write-worker", "contract": null, "schema": null, "queries": "queries/sp-write-worker.ts", "migrationPrefix": null, "exports": [{"barrel": "sp-write-worker.ts", "order": 0, "clause": "{ isSpWriteDispatchCurrent, listSpWriteProviderPlans, readSpWriteDatabaseTime, readSpWriteRecoveryResult }", "after": ""}]},
  {"domain": "queries/spapi", "contract": null, "schema": null, "queries": "queries/spapi.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 32, "clause": "*", "after": ""}]},
  {"domain": "queries/sqp", "contract": null, "schema": null, "queries": "queries/sqp.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 31, "clause": "*", "after": ""}]},
  {"domain": "queries/tags", "contract": null, "schema": null, "queries": "queries/tags.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 33, "clause": "*", "after": ""}]},
  {"domain": "queries/team-invitation-acceptance", "contract": null, "schema": null, "queries": "queries/team-invitation-acceptance.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 4, "clause": "*", "after": ""}]},
  {"domain": "queries/time-machine", "contract": null, "schema": null, "queries": "queries/time-machine.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 34, "clause": "*", "after": ""}]},
  {"domain": "queries/time-machine-writes", "contract": null, "schema": null, "queries": "queries/time-machine-writes.ts", "migrationPrefix": null, "exports": []},
  {"domain": "queries/tokens", "contract": null, "schema": null, "queries": "queries/tokens.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 36, "clause": "*", "after": ""}]},
  {"domain": "recommendation-worker", "contract": null, "schema": null, "queries": "recommendation-worker.ts", "migrationPrefix": null, "exports": []},
  {"domain": "schema/agency", "contract": null, "schema": "schema/agency.ts", "queries": null, "migrationPrefix": null, "exports": [{"barrel": "schema/index.ts", "order": 3, "clause": "*", "after": ""}]},
  {"domain": "schema/analysis", "contract": null, "schema": "schema/analysis.ts", "queries": null, "migrationPrefix": "20260813120600", "exports": [{"barrel": "schema/index.ts", "order": 9, "clause": "*", "after": ""}]},
  {"domain": "schema/apply", "contract": null, "schema": "schema/apply.ts", "queries": null, "migrationPrefix": "20260813120700", "exports": [{"barrel": "schema/index.ts", "order": 10, "clause": "*", "after": ""}]},
  {"domain": "schema/bid-series", "contract": null, "schema": "schema/bid-series.ts", "queries": null, "migrationPrefix": "20260814190000", "exports": [{"barrel": "schema/index.ts", "order": 6, "clause": "*", "after": ""}]},
  {"domain": "schema/campaign-creation-previews", "contract": null, "schema": "schema/campaign-creation-previews.ts", "queries": null, "migrationPrefix": null, "exports": [{"barrel": "schema/index.ts", "order": 19, "clause": "*", "after": ""}]},
  {"domain": "schema/columns", "contract": null, "schema": "schema/columns.ts", "queries": null, "migrationPrefix": null, "exports": [{"barrel": "schema/index.ts", "order": 0, "clause": "*", "after": ""}]},
  {"domain": "schema/economics", "contract": null, "schema": "schema/economics.ts", "queries": null, "migrationPrefix": "20260827150300", "exports": [{"barrel": "schema/index.ts", "order": 7, "clause": "*", "after": ""}]},
  {"domain": "schema/entities", "contract": null, "schema": "schema/entities.ts", "queries": null, "migrationPrefix": "20260813120200", "exports": [{"barrel": "schema/index.ts", "order": 4, "clause": "*", "after": ""}]},
  {"domain": "schema/enums", "contract": null, "schema": "schema/enums.ts", "queries": null, "migrationPrefix": null, "exports": [{"barrel": "schema/index.ts", "order": 1, "clause": "*", "after": ""}]},
  {"domain": "schema/experiments", "contract": null, "schema": "schema/experiments.ts", "queries": null, "migrationPrefix": "20260814180000", "exports": [{"barrel": "schema/index.ts", "order": 11, "clause": "*", "after": ""}]},
  {"domain": "schema/facts", "contract": null, "schema": "schema/facts.ts", "queries": null, "migrationPrefix": "20260813120300", "exports": [{"barrel": "schema/index.ts", "order": 5, "clause": "*", "after": ""}]},
  {"domain": "schema/grid-views", "contract": null, "schema": "schema/grid-views.ts", "queries": null, "migrationPrefix": "20260915120000", "exports": [{"barrel": "schema/index.ts", "order": 20, "clause": "*", "after": ""}]},
  {"domain": "schema/index", "contract": null, "schema": null, "queries": "schema/index.ts", "migrationPrefix": null, "exports": [{"barrel": "index.ts", "order": 5, "clause": "*", "after": ""}]},
  {"domain": "schema/integrations", "contract": null, "schema": "schema/integrations.ts", "queries": null, "migrationPrefix": "20260827140000", "exports": [{"barrel": "schema/index.ts", "order": 12, "clause": "*", "after": ""}]},
  {"domain": "schema/mcp", "contract": null, "schema": "schema/mcp.ts", "queries": null, "migrationPrefix": null, "exports": [{"barrel": "schema/index.ts", "order": 18, "clause": "*", "after": ""}]},
  {"domain": "schema/operator-intelligence", "contract": null, "schema": "schema/operator-intelligence.ts", "queries": null, "migrationPrefix": "20260829120000", "exports": [{"barrel": "schema/index.ts", "order": 15, "clause": "*", "after": ""}]},
  {"domain": "schema/seams", "contract": null, "schema": "schema/seams.ts", "queries": null, "migrationPrefix": "20260813121100", "exports": [{"barrel": "schema/index.ts", "order": 14, "clause": "*", "after": ""}]},
  {"domain": "schema/sp-write-outbox", "contract": null, "schema": "schema/sp-write-outbox.ts", "queries": null, "migrationPrefix": null, "exports": [{"barrel": "schema/index.ts", "order": 17, "clause": "*", "after": ""}]},
  {"domain": "schema/sp-writes", "contract": null, "schema": "schema/sp-writes.ts", "queries": null, "migrationPrefix": "20260901020000", "exports": [{"barrel": "schema/index.ts", "order": 16, "clause": "*", "after": ""}]},
  {"domain": "schema/surface", "contract": null, "schema": "schema/surface.ts", "queries": null, "migrationPrefix": "20260813120800", "exports": [{"barrel": "schema/index.ts", "order": 13, "clause": "*", "after": ""}]},
  {"domain": "schema/sync", "contract": null, "schema": "schema/sync.ts", "queries": null, "migrationPrefix": "20260813120500", "exports": [{"barrel": "schema/index.ts", "order": 8, "clause": "*", "after": ""}]},
  {"domain": "schema/tenancy", "contract": null, "schema": "schema/tenancy.ts", "queries": null, "migrationPrefix": "20260813120100", "exports": [{"barrel": "schema/index.ts", "order": 2, "clause": "*", "after": ""}]},
  {"domain": "sp-write-application", "contract": null, "schema": null, "queries": "sp-write-application.ts", "migrationPrefix": null, "exports": []},
  {"domain": "sp-write-persistence", "contract": null, "schema": null, "queries": "sp-write-persistence.ts", "migrationPrefix": null, "exports": []},
  {"domain": "sp-write-worker", "contract": null, "schema": null, "queries": "sp-write-worker.ts", "migrationPrefix": null, "exports": []},
  {"domain": "testing/errors", "contract": null, "schema": null, "queries": "testing/errors.ts", "migrationPrefix": null, "exports": [{"barrel": "testing/index.ts", "order": 0, "clause": "*", "after": ""}]},
  {"domain": "testing/harness", "contract": null, "schema": null, "queries": "testing/harness.ts", "migrationPrefix": null, "exports": [{"barrel": "testing/index.ts", "order": 1, "clause": "*", "after": ""}]},
  {"domain": "testing/index", "contract": null, "schema": null, "queries": "testing/index.ts", "migrationPrefix": null, "exports": []},
  {"domain": "testing/mcp-write-source", "contract": null, "schema": null, "queries": "testing/mcp-write-source.ts", "migrationPrefix": null, "exports": [{"barrel": "testing/index.ts", "order": 5, "clause": "*", "after": ""}]},
  {"domain": "testing/recommendation-method", "contract": null, "schema": null, "queries": "testing/recommendation-method.ts", "migrationPrefix": null, "exports": [{"barrel": "testing/index.ts", "order": 6, "clause": "*", "after": ""}]},
  {"domain": "testing/rls", "contract": null, "schema": null, "queries": "testing/rls.ts", "migrationPrefix": null, "exports": [{"barrel": "testing/index.ts", "order": 2, "clause": "*", "after": "\n"}]},
  {"domain": "testing/sp-write-consumer-scope", "contract": null, "schema": null, "queries": "testing/sp-write-consumer-scope.ts", "migrationPrefix": null, "exports": []},
  {"domain": "testing/sp-write-legacy-application", "contract": null, "schema": null, "queries": "testing/sp-write-legacy-application.ts", "migrationPrefix": null, "exports": [{"barrel": "testing/index.ts", "order": 3, "clause": "*", "after": ""}]},
  {"domain": "testing/sp-write-synthetic-execution", "contract": null, "schema": null, "queries": "testing/sp-write-synthetic-execution.ts", "migrationPrefix": null, "exports": [{"barrel": "testing/index.ts", "order": 4, "clause": "*", "after": ""}]},
  {"domain": "testing/sp-write-tenant-fixture", "contract": null, "schema": null, "queries": "testing/sp-write-tenant-fixture.ts", "migrationPrefix": null, "exports": []},
  {"domain": "worker", "contract": null, "schema": null, "queries": "worker.ts", "migrationPrefix": null, "exports": []},
];

const headers: Record<string, string> = {
  "campaign-creation-previews.ts": "/** Saved campaign review boundary. No approval or worker execution is exported. */\n",
  "index.ts": "/**\n * `@wizard-ads/db` (owned by WP-01).\n *\n * The database layer: a Drizzle mirror of `supabase/migrations`, typed query\n * helpers over it, and RLS test utilities (exported separately from\n * `@wizard-ads/db/testing`).\n *\n * Three things this package will not do, each one deliberate:\n *\n *  - It does not generate the schema. The SQL migrations are the source of\n *    truth; `drizzle-kit` is not a dependency and the mirror is asserted\n *    against a freshly migrated database instead of trusted.\n *  - It does not reimplement anything atomic. Claiming a job, enqueueing due\n *    schedules, moving a credential in or out of Vault and rolling up a\n *    partition are all SQL functions; the helpers here call them.\n *  - It does not report success it has not verified. Every loader counts rows\n *    written against rows offered and throws on a mismatch.\n */\nexport const PACKAGE_NAME = '@wizard-ads/db' as const;\n\n",
  "mcp-writes.ts": "/** Operator key management and, later, bounded MCP admission. Never calls Amazon. */\n",
  "operator.ts": "/** Installation commands. Not a product role or a web/MCP application capability. */\n",
  "schema/index.ts": "/**\n * The Drizzle mirror of `supabase/migrations`.\n *\n * Direction of truth, stated once so nobody has to guess: the SQL migrations\n * are the schema. This package mirrors them so queries are typed. Nothing here\n * generates DDL, `drizzle-kit` is deliberately not a dependency, and\n * `schema.test.ts` asserts the mirror against a freshly migrated database so\n * the two cannot drift quietly.\n */\n",
  "sp-write-application.ts": "/** Actor-bound application facade. Every command runs inside its caller's WP-253 boundary. */\n",
  "sp-write-persistence.ts": "/**\n * Explicit Sponsored Products write-persistence boundary.\n *\n * This module is intentionally absent from the package root and worker barrels.\n * Importing it supplies database capabilities only; it registers no job, worker,\n * provider, route, schedule, or deployment behavior.\n */\n",
  "sp-write-worker.ts": "/** Inert worker reads. No provider, timer, queue registration or admission. */\n",
  "testing/index.ts": "/**\n * Test utilities: a migrated throwaway database, and the role switching that\n * makes an RLS assertion mean something.\n *\n * Exported from `@wizard-ads/db/testing` so another package can assert its own\n * policies against the real schema without depending on the test files here.\n */\n",
  "worker.ts": "/** Worker-only credential reads. Web imports of this subpath are lint failures. */\n"
};

/** Preserve export selection, ordering, comments and whitespace byte for byte. */
export function generatedBarrels(): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([barrel, header]) => {
    const exports = PACKAGE_REGISTRY.flatMap((entry) => entry.exports
      .filter((item) => item.barrel === barrel)
      .map((item) => ({ ...item, module: entry.contract ?? entry.schema ?? entry.queries })));
    return [barrel, header + exports.sort((a, b) => a.order - b.order).map((item) => {
      if (!item.module) throw new Error(`Missing module for ${barrel}`);
      const directory = barrel.split('/').slice(0, -1);
      const module = item.module.replace(/\.ts$/, '.js').split('/');
      while (directory.length && directory[0] === module[0]) {
        directory.shift();
        module.shift();
      }
      const relative = directory.length ? '../'.repeat(directory.length) + module.join('/') : './' + module.join('/');
      return `export ${item.clause} from '${relative}';\n${item.after}`;
    }).join('')];
  }));
}
