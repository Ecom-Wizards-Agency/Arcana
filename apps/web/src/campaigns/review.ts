import { CampaignCreationAdmissionValidation, campaignCreationReviewExpiresAt, type CampaignDraft, type CampaignCreationProviderScope } from '@wizard-ads/shared';
import { CampaignCreationApprovalView, campaignCreationReviewFreshness } from '@wizard-ads/shared/campaign-creation-approval';

/** Missing provider authority stays unavailable, including after an in-place draft edit. */
export function unavailableCampaignReview(draft: CampaignDraft, label: string, checkedAt: string): CampaignCreationApprovalView {
  const source = { plan: draft.plan, profile: { id: draft.profileId, label }, checkedAt,
    current: { orgId: draft.orgId, profileId: draft.profileId, planFingerprint: draft.plan.fingerprint, providerScope: null,
      checks: draft.plan.nodes.map((node) => ({ nodeId: node.nodeId, nodeFingerprint: node.fingerprint, result: 'unknown' as const,
        reason: 'unavailable' as const, checkedAt: null, validUntil: null })), assets: [] } };
  return CampaignCreationApprovalView.parse({ ...source, schemaVersion: 'openspell.campaign-creation-approval-view.v1',
    freshness: campaignCreationReviewFreshness(source), recordedContext: { guardrails: 'not_recorded', provenance: 'not_recorded', frozenProfileLabel: 'not_recorded' }, admission: { kind: 'unavailable' } });
}

export function savedCampaignCreationReview(draft: CampaignDraft, label: string, checkedAt: string,
  providerScope: CampaignCreationProviderScope | null): CampaignCreationApprovalView {
  if (!draft.validation || !CampaignCreationAdmissionValidation.safeParse(draft.validation).success
    || draft.plan.schemaVersion !== 'openspell.campaign-creation-plan.v2') return unavailableCampaignReview(draft, label, checkedAt);
  const validUntil = campaignCreationReviewExpiresAt(draft.plan.expiresAt, draft.validation.checkedAt);
  const source = { plan: draft.plan, profile: { id: draft.profileId, label }, checkedAt,
    current: { orgId: draft.orgId, profileId: draft.profileId, planFingerprint: draft.plan.fingerprint, providerScope,
      checks: draft.plan.nodes.map((node) => ({ nodeId: node.nodeId, nodeFingerprint: node.fingerprint,
        result: 'passed' as const, reason: null, checkedAt: draft.validation!.checkedAt, validUntil })), assets: [] } };
  return CampaignCreationApprovalView.parse({ ...source, schemaVersion: 'openspell.campaign-creation-approval-view.v1',
    freshness: campaignCreationReviewFreshness(source), recordedContext: { guardrails: 'not_recorded', provenance: 'not_recorded', frozenProfileLabel: 'not_recorded' }, admission: { kind: 'none' } });
}
