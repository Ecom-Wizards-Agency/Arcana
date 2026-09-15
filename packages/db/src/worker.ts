/** Worker-only credential reads. Web imports of this subpath are lint failures. */
export { getIntegrationSecret } from './queries/integrations.js';
export * from './queries/amazon-connection-worker.js';
export { lockPrivilegedOrgEditor } from './queries/privileged-actor.js';
export { OwnCollectorConflictError, collectorProfile, readOwnBidMirrors, readOwnListingAsins, readCollectorExports, persistEffectiveBidObservations, persistListingSnapshots } from './queries/own-collectors.js';
export { importScheduledPrompts } from './queries/sponsored-prompts.js';
export { prepareProviderEvidenceRun, authorizeProviderEvidencePage, persistProviderEvidencePage, failProviderEvidenceRun } from './queries/provider-evidence.js';
