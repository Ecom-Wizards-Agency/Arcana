import { createHash } from 'node:crypto';
import { readRecordedCampaignCreationPreview, CampaignCreationPreviewError } from '@wizard-ads/db/campaign-creation-previews';
import { verifyCampaignCreationPlanFingerprints } from '@wizard-ads/shared';
import { CampaignCreationApprovalRequest, CampaignCreationApprovalSource, CampaignCreationApprovalScope,
  CampaignCreationApprovalView, campaignCreationReviewFreshness } from '@wizard-ads/shared/campaign-creation-approval';
import { requireCapability } from '../server/org-role';
import { openWebDatabase, requestActor } from '../server/request-context';

const hasher = { algorithm: 'sha256' as const,
  digest: (input: string) => createHash('sha256').update(input).digest('hex') };

/**
 * Pure projection of a validated snapshot. The authenticated loader below owns
 * membership/capability and the recorded read; rendering fixtures may call this directly.
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

/** Reopen one saved plan. Request headers establish identity; loading grants no write authority. */
export async function loadCampaignCreationApproval(
  headers: Headers,
  input: CampaignCreationApprovalRequest,
): Promise<CampaignCreationApprovalView> {
  const actor = await requestActor(headers);
  const request = CampaignCreationApprovalRequest.safeParse(input);
  if (!request.success) throw new CampaignCreationPreviewError('invalid_request');
  const database = openWebDatabase();
  try {
    await requireCapability(database, actor, 'applyAmazonChanges');
    const source = await readRecordedCampaignCreationPreview(database, actor, request.data);
    return projectCampaignCreationApproval({ orgId: actor.orgId, ...request.data }, source);
  } finally {
    await database.close();
  }
}
