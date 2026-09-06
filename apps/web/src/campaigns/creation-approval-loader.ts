import { createHash } from 'node:crypto';
import { verifyCampaignCreationPlanFingerprints } from '@wizard-ads/shared';
import { CampaignCreationApprovalSource, CampaignCreationApprovalScope,
  CampaignCreationApprovalView, campaignCreationReviewFreshness } from '@wizard-ads/shared/campaign-creation-approval';

const hasher = { algorithm: 'sha256' as const,
  digest: (input: string) => createHash('sha256').update(input).digest('hex') };

/**
 * Pure server projection, not an authenticated database loader. The future loader
 * must establish membership/capability and read one owned, consistent snapshot.
 * No fallback generator, write method, route or production reader exists here.
 */
export function projectCampaignCreationApproval(
  expectedScope: CampaignCreationApprovalScope,
  rawSnapshot: unknown,
): CampaignCreationApprovalView {
  try {
    const scope = CampaignCreationApprovalScope.parse(expectedScope);
    const source = CampaignCreationApprovalSource.parse(rawSnapshot);
    const plan = verifyCampaignCreationPlanFingerprints(source.plan, hasher);
    if (plan.orgId !== scope.orgId || plan.profileId !== scope.profileId || plan.id !== scope.planId) {
      throw new Error('scope mismatch');
    }
    const admission = source.admission.kind === 'recorded'
      ? { kind: 'recorded' as const, executionId: source.admission.receipt.executionId,
        approvedBy: source.admission.receipt.approvedBy, approvedAt: source.admission.receipt.approvedAt,
        snapshot: source.admission.execution?.snapshot ?? null }
      : source.admission;
    return CampaignCreationApprovalView.parse({
      schemaVersion: 'openspell.campaign-creation-approval-view.v1', plan,
      profile: source.profile, checkedAt: source.checkedAt, current: source.current,
      freshness: campaignCreationReviewFreshness(source),
      recordedContext: { guardrails: 'not_recorded', provenance: 'not_recorded', frozenProfileLabel: 'not_recorded' },
      admission,
    });
  } catch {
    // A failed read/validation must not disclose a foreign plan's labels or IDs.
    throw new Error('Campaign review is unavailable');
  }
}
