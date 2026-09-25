import { CampaignBuilderResult, campaignCreationBatchSummary, deriveCampaignCreationExecutionStatus,
  type CampaignCreationBatch, type CampaignCreationAccounting } from '@wizard-ads/shared';

/** Resource projection retains original parents; child-batch accounting is shown separately. */
export function campaignCreationResult(batch: CampaignCreationBatch): CampaignBuilderResult {
  const summary = campaignCreationBatchSummary(batch).accounting;
  const inherited = batch.lineage?.inheritedResources ?? [];
  const resources = batch.plan.nodes.filter((node) => node.effect === 'irreversible_create').map((node) => {
    const row = batch.nodes.find((entry) => entry.nodeId === node.nodeId);
    const reused = inherited.some((entry) => entry.nodeId === node.nodeId);
    const succeeded = reused || row?.result?.outcome === 'succeeded';
    const failed = row?.result?.outcome === 'authoritative_rejected';
    return { nodeId: node.nodeId, kind: node.kind === 'campaign.create' ? 'campaign' : node.kind === 'ad_group.create' ? 'ad_group'
      : node.kind === 'ad.create' ? 'product_ad' : 'keyword', requested: 1, succeeded: succeeded ? 1 : 0,
    status: succeeded ? 'created' : failed ? 'failed' : row?.intent ? 'unknown' : 'pending',
    message: row?.result?.sanitizedMessage ?? null, responseCode: row?.result?.providerCode ?? null };
  });
  const accounting: CampaignCreationAccounting = {
    operatorApproved: resources.length, pendingDispatch: summary.pending, attempted: summary.attempted + inherited.length,
    succeeded: summary.succeeded + inherited.length, failed: summary.failed, ambiguous: summary.uncertain,
    refusedAtExecution: summary.refused, blockedByDependency: summary.blocked,
    observed: summary.observed + inherited.length,
    pendingObservation: batch.nodes.filter((row) => row.intent && row.result?.outcome !== 'authoritative_rejected'
      && !['observed', 'conflict', 'not_found'].includes(row.observation?.observation ?? '')).length,
    observationNotFound: batch.nodes.filter((row) => row.observation?.observation === 'not_found').length,
    observationConflict: batch.nodes.filter((row) => row.observation?.observation === 'conflict').length,
    readChecksRequested: batch.productChecks.length, readChecksPassed: batch.productChecks.length,
    readChecksPending: 0, readChecksRefused: 0, readChecksFailed: 0,
  };
  return CampaignBuilderResult.parse({ snapshot: { status: deriveCampaignCreationExecutionStatus(accounting), accounting }, resources,
    retry: batch.lineage ? { requested: batch.nodes.length, created: summary.succeeded, duplicated: 0 } : null,
    campaignState: 'paused', currencyCode: batch.plan.providerScope.currencyCode });
}
