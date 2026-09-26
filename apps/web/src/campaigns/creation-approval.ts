import { readCampaignDraft, admitCampaignCreation, readCampaignCreationBatch, findCampaignCreationAdmission,
  readCampaignCreationGate, readCampaignCreationProviderScope, recordCampaignCreationRetryReview, CampaignCreationAdmissionError,
  type AuthenticatedEditorTransaction } from '@wizard-ads/db';
import { type CampaignCreationBatchRequest, type CampaignCreationRetryReviewRequest, type CampaignCreationBatch, type CampaignDraft,
  type CampaignBuilderContext, CampaignCreationAdmissionValidation, campaignCreationReviewExpired, campaignCreationCheckOutcomesAgree } from '@wizard-ads/shared';
import { validateBuilderDraft } from './drafts';
import { loadCampaignBuilderContext } from './data';

async function lockOwnedDraft(context: AuthenticatedEditorTransaction, request: { profileId: string; draftId: string; expectedRevision: number; planFingerprint: string }) {
  const lock = await context.sql`select id from public.campaign_drafts where org_id=${context.actor.orgId}::uuid
    and profile_id=${request.profileId}::uuid and created_by=${context.actor.userId}::uuid and id=${request.draftId}::uuid for update`;
  if (lock.length !== 1) throw new CampaignCreationAdmissionError('not_found');
  const draft = await readCampaignDraft(context, request.profileId, request.draftId);
  if (!draft) throw new CampaignCreationAdmissionError('not_found');
  if (draft.revision !== request.expectedRevision) throw new CampaignCreationAdmissionError('stale_revision');
  if (draft.plan.fingerprint !== request.planFingerprint) throw new CampaignCreationAdmissionError('stale_fingerprint');
  return draft;
}

/**
 * Approval validates only the saved plan. It never generates, compiles or dispatches a provider request.
 * It binds the persisted review evidence displayed for the requested revision: expired evidence is
 * refused with freshness_not_current, and current state is read only to confirm that evidence still holds.
 */
export async function approveSavedCampaignCreation(context: AuthenticatedEditorTransaction, request: CampaignCreationBatchRequest) {
  const draft = await lockOwnedDraft(context, request);
  if (draft.status === 'blocked') throw new CampaignCreationAdmissionError('blocking_check');
  const existing = await findCampaignCreationAdmission(context, request);
  if (existing) return existing;
  if (draft.status !== (request.action === 'create' ? 'validated' : 'approved') || draft.validation === null) {
    throw new CampaignCreationAdmissionError('draft_not_validated');
  }
  const displayed = CampaignCreationAdmissionValidation.safeParse(draft.validation);
  if (draft.validation.checks.some((check) => check.blocking)) throw new CampaignCreationAdmissionError('blocking_check');
  if (!displayed.success || campaignCreationReviewExpired(draft.plan.expiresAt, displayed.data.checkedAt, Date.now())) {
    throw new CampaignCreationAdmissionError('freshness_not_current');
  }
  const gate = await readCampaignCreationGate(context, draft.plan);
  if (!gate.available) throw new CampaignCreationAdmissionError(gate.reason ?? 'executor_unavailable');
  const scope = await readCampaignCreationProviderScope(context, request.profileId);
  if (draft.plan.schemaVersion !== 'openspell.campaign-creation-plan.v2' || JSON.stringify(scope) !== JSON.stringify(draft.plan.providerScope)) {
    throw new CampaignCreationAdmissionError('provider_scope_changed');
  }
  const parent = request.action === 'retry' ? await readCampaignCreationBatch(context, request.profileId, request.parentBatchId) : null;
  if (request.action === 'retry' && !parent) throw new CampaignCreationAdmissionError('retry_not_allowed');
  const source = await loadCampaignBuilderContext(context, request.profileId);
  const current = await revalidateCreationDraft(context, draft, source, parent);
  if (current.checks.some((check) => check.blocking)) throw new CampaignCreationAdmissionError('blocking_check');
  // A changed outcome means the operator saw different evidence; a new review is required.
  if (!campaignCreationCheckOutcomesAgree(displayed.data.checks, current.checks)) throw new CampaignCreationAdmissionError('freshness_not_current');
  return admitCampaignCreation(context, request, displayed.data);
}

/**
 * Refresh the evidence shown before a separate retry or recovery confirmation. The approved draft
 * records it at a new revision; nothing is admitted, queued or sent to Amazon.
 */
export async function reviewSavedCampaignCreationRetry(context: AuthenticatedEditorTransaction, request: CampaignCreationRetryReviewRequest) {
  const draft = await lockOwnedDraft(context, request);
  if (draft.status !== 'approved') throw new CampaignCreationAdmissionError('draft_not_validated');
  const parent = await readCampaignCreationBatch(context, request.profileId, request.parentBatchId);
  if (!parent || parent.draftId !== draft.id || parent.plan.fingerprint !== draft.plan.fingerprint) {
    throw new CampaignCreationAdmissionError('retry_not_allowed');
  }
  const source = await loadCampaignBuilderContext(context, request.profileId);
  return recordCampaignCreationRetryReview(context, request, await revalidateCreationDraft(context, draft, source, parent));
}

/** Retry review and admission use the frozen draft, excluding only its observed campaigns. */
export async function revalidateCreationDraft(context: Pick<AuthenticatedEditorTransaction, 'sql' | 'actor'>,
  draft: CampaignDraft, source: CampaignBuilderContext, parent: CampaignCreationBatch | null) {
  const inheritedCampaignIds = parent?.nodes.filter((row) => parent.plan.nodes.some((node) => node.nodeId === row.nodeId && node.kind === 'campaign.create')
    && row.observation?.observation === 'observed').map((row) => row.observation!.providerEntityId) ?? [];
  for (const resource of parent?.lineage?.inheritedResources ?? []) {
    if (parent?.plan.nodes.some((node) => node.nodeId === resource.nodeId && node.kind === 'campaign.create')) {
      inheritedCampaignIds.push(resource.providerEntityId);
    }
  }
  const names = await context.sql<{ name: string }[]>`select name from public.campaigns where org_id=${context.actor.orgId}::uuid
    and profile_id=${draft.profileId}::uuid and not (amazon_id=any(${context.sql.array(inheritedCampaignIds)}::text[]))`;
  const uncertainCampaignNames = parent?.plan.nodes.flatMap((node) => node.kind === 'campaign.create'
    && parent.nodes.some((row) => row.nodeId === node.nodeId && row.observation?.observation === 'uncertain') ? [node.payload.name] : []) ?? [];
  // Explicit retry reads these identities before it can reserve a new create.
  return validateBuilderDraft(draft, source, names.map((row) => row.name).filter((name) => !uncertainCampaignNames.includes(name)), new Date().toISOString());
}
