import type { SpWriteRecordedPreview } from '@wizard-ads/shared/sp-write-application';
import { referenceRows } from '../optimizer-review/render-fixture';

/** Synthetic source identities matched to the exact presentation plan. */
export function confirmationProposals(recorded: SpWriteRecordedPreview) {
  const evidence = recorded.preview.evidence;
  if (!evidence || evidence.schemaVersion === 'openspell.sp-write-preview-evidence.v2') return [];
  return evidence.provenance.rows.map((source, index) => ({
    ...referenceRows[0]!, id: source.recommendationId, runId: source.runId, profileId: recorded.preview.plan.profileId,
    campaignId: `synthetic-campaign-${index + 1}`, campaignName: `Synthetic campaign ${index + 1}`,
  }));
}
