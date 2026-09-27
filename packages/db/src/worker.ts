/** Worker-only credential reads. Web imports of this subpath are lint failures. */
export { getIntegrationSecret } from './queries/integrations.js';
export * from './queries/amazon-connection-worker.js';
export { lockPrivilegedOrgEditor } from './queries/privileged-actor.js';
export { OwnCollectorReferenceError, OwnCollectorConflictError, collectorProfile, readOwnBidMirrors, readOwnListingAsins, readListingCollectorCoverage, readCollectorExports, persistEffectiveBidObservations, persistListingSnapshots } from './queries/own-collectors.js';
export { importScheduledPrompts } from './queries/sponsored-prompts.js';
export { catalogueDigest, catalogueSourceEnabled, persistCatalogueCollection, recordCatalogueCursorFailure, resolveAmazonChangeEvents } from './queries/ads-catalogue.js';
export { prepareProviderEvidenceRun, authorizeProviderEvidencePage, persistProviderEvidencePage, failProviderEvidenceRun } from './queries/provider-evidence.js';
export { creatorContentDigest, persistCreatorImport, recordFailedCreatorImport, type CreatorActionWrite, type CreatorImportBatch, type CreatorImportFailureInput, type CreatorImportSection, type CreatorQueueWrite, type CreatorRecordWrite, type CreatorShipmentWrite, type CreatorSweepWrite } from './queries/creators.js';
export { creatorQueueRows, creatorRegistryRows, creatorSweepRow, legacyReservationId, type CreatorRegistryRows } from './queries/creators-runner.js';
export { CREATOR_OBSERVABLE_LANE_STATES, countActiveCreatorSpApiConnections, creatorPreflightRow, listCreatorMcfObserveScopes, readCreatorObservableLanes, readCreatorObservedKeys, recordCreatorMcfObservation, type CreatorObservableLane, type CreatorPreflightWrite } from './queries/creators-samples.js';
export { claimCreatorMcfOutbox, expireCreatorMcfCustody, markCreatorMcfLadderExhausted, purgeCreatorMcfMasks, readCreatorMcfActiveKeyIds, readCreatorMcfAlertSummary, readCreatorMcfCustody, readCreatorMcfCustodyResidue, recordCreatorMcfCancelOutcome, recordCreatorMcfCancelPreview, recordCreatorMcfCancelUnsent, recordCreatorMcfHeartbeat, recordCreatorMcfOutcome, recordCreatorMcfPreview, recordCreatorMcfSettlement, refuseCreatorMcfPreview, releaseCreatorMcfClaim, reserveCreatorMcfCancel, reserveCreatorMcfDispatch, type CreatorMcfAlertCode, type CreatorMcfAlertSummary, type CreatorMcfCancelClaim, type CreatorMcfCancelReservation, type CreatorMcfCancelUnsentReason, type CreatorMcfClaim, type CreatorMcfHeartbeat, type CreatorMcfOrderRead, type CreatorMcfOutboxAction, type CreatorMcfPreviewRefusal, type CreatorMcfReservation, type CreatorMcfWorkerDecision } from './queries/creators-mcf-send.js';
export { createCampaignCreationLedger } from './queries/campaign-creation-worker.js';
export * from './queries/market-signals.js';
