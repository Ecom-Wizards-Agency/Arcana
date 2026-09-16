'use client';
import { CampaignCreationBatch, type CampaignCreationBatchRequest } from '@wizard-ads/shared';

async function responseBatch(response: Response) {
  const value: unknown = await response.json();
  if (!response.ok) throw new Error(typeof value === 'object' && value !== null && 'code' in value
    ? `Creation refused: ${String(value.code)}. Review the saved draft.` : 'Creation status is unavailable. Reload the recorded batch.');
  return CampaignCreationBatch.parse(value);
}
export async function approveCampaignCreation(request: CampaignCreationBatchRequest) {
  const batch = await responseBatch(await fetch('/api/campaigns/creation', { method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) }));
  // An unchanged plan may replay an earlier approval after revalidation advances its revision.
  if (batch.draftId !== request.draftId || batch.draftRevision > request.expectedRevision
    || batch.plan.fingerprint !== request.planFingerprint || batch.plan.profileId !== request.profileId
    || (request.action === 'create' ? batch.lineage !== null : batch.lineage?.parentBatchId !== request.parentBatchId
      || JSON.stringify(batch.lineage?.nodeIds) !== JSON.stringify(request.nodeIds))) throw new Error('Creation response does not match the approved draft. Reload the recorded batch.');
  return batch;
}
export async function fetchCampaignCreation(profileId: string, batchId: string, signal: AbortSignal) {
  const batch = await responseBatch(await fetch(`/api/campaigns/creation/status?${new URLSearchParams({ profileId, batchId })}`,
    { credentials: 'same-origin', cache: 'no-store', signal }));
  if (batch.id !== batchId || batch.plan.profileId !== profileId) throw new Error('Creation status scope changed.');
  return batch;
}

/** Reload server-owned gate and review evidence after validation or before retry. */
export function refreshCampaignCreationReview(step: 'review' | 'retry') {
  const url = new URL(window.location.href); url.searchParams.set('step', step);
  window.location.assign(url);
}
