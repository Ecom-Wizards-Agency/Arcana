import { z } from 'zod';
import { Uuid, AmazonId } from './primitives.js';
import { CampaignCreationAdmissionValidation } from './campaign-creation-admission.js';
import {
  CampaignCreationNodeV2, CampaignCreationPlanV2, CampaignCreationProviderScope,
  CampaignCreationSha256, CampaignCreationProviderResult,
  serializeCampaignCreationNodeFingerprint, serializeCampaignCreationPlanFingerprint,
  verifyCampaignCreationPlanFingerprints, orderCampaignCreationNodes, type CampaignCreationPlan, type CampaignCreationSha256Hasher,
} from './campaign-creation.js';

/** Admission binds the saved artifact the operator saw, never a newly generated plan. */
const binding = { profileId: Uuid, draftId: Uuid, expectedRevision: z.number().int().positive(),
  planFingerprint: CampaignCreationSha256 };
export const CampaignCreationBatchRequest = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), ...binding }).strict(),
  z.object({ action: z.literal('retry'), ...binding, parentBatchId: Uuid,
    nodeIds: z.array(Uuid).min(1).refine((ids) => new Set(ids).size === ids.length, 'Duplicate retry node') }).strict(),
]);
export type CampaignCreationBatchRequest = z.infer<typeof CampaignCreationBatchRequest>;
/** Refreshes the evidence displayed before a separate retry or recovery confirmation. It admits nothing. */
export const CampaignCreationRetryReviewRequest = z.object({ ...binding, parentBatchId: Uuid }).strict();
export type CampaignCreationRetryReviewRequest = z.infer<typeof CampaignCreationRetryReviewRequest>;
export const CampaignCreationRefusalCode = z.enum([
  'stale_fingerprint', 'stale_revision', 'draft_not_validated', 'blocking_check', 'freshness_not_current',
  'environment_gate_off', 'profile_not_allowlisted', 'executor_unavailable', 'plan_not_sponsored_products',
  'not_found', 'invalid_request', 'authorization_refused', 'retry_not_allowed', 'provider_scope_changed',
  'ambiguous_readback',
]);
export type CampaignCreationRefusalCode = z.infer<typeof CampaignCreationRefusalCode>;
export const CampaignCreationBatchState = z.enum([
  'requested', 'admitted', 'attempted', 'succeeded', 'failed', 'partial_failed', 'observed',
  'awaiting_observation', 'refused', 'blocked', 'needs_attention',
]);
export type CampaignCreationBatchState = z.infer<typeof CampaignCreationBatchState>;

export const CampaignCreationBatchIntent = z.object({
  id: Uuid, requestDigest: CampaignCreationSha256, nodeRequestDigest: CampaignCreationSha256,
  reservedAt: z.iso.datetime(), deadline: z.iso.datetime(),
  preflightObservationId: Uuid.optional(),
}).strict();
export type CampaignCreationBatchIntent = z.infer<typeof CampaignCreationBatchIntent>;
export const CampaignCreationBatchObservation = z.object({
  id: Uuid, mode: z.enum(['provider_id', 'identity']), identityFingerprint: CampaignCreationSha256,
  providerEntityId: AmazonId.nullable(),
  observation: z.enum(['observed', 'pending', 'not_found', 'conflict', 'uncertain', 'ambiguous_readback']),
  complete: z.boolean(), startedAt: z.iso.datetime(), responseDigest: CampaignCreationSha256,
  accounting: z.object({ pages: z.number().int().nonnegative(), loaded: z.number().int().nonnegative(),
    parsed: z.number().int().nonnegative(), matched: z.number().int().nonnegative() }).strict(),
  reason: z.string().min(1).max(512).nullable(),
  observedAt: z.iso.datetime(), requestDigest: CampaignCreationSha256,
}).strict().superRefine((read, ctx) => {
  const { loaded, parsed, matched } = read.accounting;
  if (parsed > loaded || matched > parsed || (read.complete && loaded !== parsed)
    || Date.parse(read.startedAt) > Date.parse(read.observedAt)
    || (read.observation !== 'pending' && !read.complete)
    || (['observed', 'conflict'].includes(read.observation) && (matched !== 1 || read.providerEntityId === null))
    || (['not_found', 'uncertain'].includes(read.observation) && matched !== 0)
    || (read.observation === 'ambiguous_readback' && matched < 2)
    || (read.observation === 'uncertain' && read.reason === null)) {
    ctx.addIssue({ code: 'custom', message: 'Creation observation must reconcile complete scan counts and exact identity' });
  }
});
export type CampaignCreationBatchObservation = z.infer<typeof CampaignCreationBatchObservation>;
export const CampaignCreationBatchNode = z.object({
  nodeId: Uuid, nodeFingerprint: CampaignCreationSha256,
  intent: CampaignCreationBatchIntent.nullable(),
  result: CampaignCreationProviderResult.nullable(),
  observation: CampaignCreationBatchObservation.nullable(),
  observations: z.array(CampaignCreationBatchObservation).default([]),
  refusal: z.enum(['gate_closed', 'dependency_failed', 'expired']).nullable(),
}).strict().superRefine((node, ctx) => {
  if (node.result !== null && (node.intent === null || node.result.effect !== 'irreversible_create'
    || node.result.nodeId !== node.nodeId || node.result.nodeFingerprint !== node.nodeFingerprint
    || node.result.providerCallId !== node.intent.id || node.result.attemptId !== node.intent.id
    || node.result.requestDigest !== node.intent.requestDigest
    || node.result.nodeRequestDigest !== node.intent.nodeRequestDigest)) {
    ctx.addIssue({ code: 'custom', message: 'Result must match the reserved node and request' });
  }
  const preflight = node.observation !== null && node.intent?.preflightObservationId === node.observation.id;
  if (node.observation !== null && ((node.intent && node.observation.requestDigest !== node.intent.requestDigest)
    || (!preflight && node.result?.outcome === 'succeeded' && node.observation.providerEntityId !== node.result.providerEntityId)
    || (!preflight && node.result && Date.parse(node.observation.observedAt) < Date.parse(node.result.completedAt))
    || (node.result?.outcome !== 'succeeded' && node.observation.mode !== 'identity'))) {
    ctx.addIssue({ code: 'custom', message: 'Observation must bind the reserved request or an explicit retry preflight' });
  }
  if (new Set(node.observations.map((read) => read.id)).size !== node.observations.length
    || (node.observations.length > 0 && !node.observations.some((read) => read.id === node.observation?.id))) {
    ctx.addIssue({ code: 'custom', message: 'Observation history must be unique and include the projected observation' });
  }
  if (node.refusal !== null && (node.intent !== null || node.observation?.observation === 'observed')) ctx.addIssue({ code: 'custom', message: 'Reserved or observed resources cannot be refused retroactively' });
});
export type CampaignCreationBatchNode = z.infer<typeof CampaignCreationBatchNode>;

export const CampaignCreationInheritedResource = z.object({
  batchId: Uuid, nodeId: Uuid, nodeFingerprint: CampaignCreationSha256,
  providerEntityId: AmazonId, requestDigest: CampaignCreationSha256, observedAt: z.iso.datetime(),
}).strict();
export const CampaignCreationRetryLineage = z.object({
  parentBatchId: Uuid, planFingerprint: CampaignCreationSha256, nodeIds: z.array(Uuid).min(1),
  inheritedResources: z.array(CampaignCreationInheritedResource),
}).strict();
export type CampaignCreationRetryLineage = z.infer<typeof CampaignCreationRetryLineage>;
export const CampaignCreationBatch = z.object({
  id: Uuid, draftId: Uuid, draftRevision: z.number().int().positive(), actorId: Uuid,
  plan: CampaignCreationPlanV2, admittedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  environmentGateVersion: Uuid, profileGrantVersion: Uuid,
  validation: CampaignCreationAdmissionValidation,
  lineage: CampaignCreationRetryLineage.nullable(),
  productChecks: z.array(z.object({ nodeId: Uuid, providerEntityId: AmazonId, observedAt: z.iso.datetime() }).strict()),
  nodes: z.array(CampaignCreationBatchNode).min(1),
}).strict().superRefine((batch, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (batch.plan.adProduct !== 'SP' || batch.plan.apiDialect !== 'sp_legacy_v3') fail('Only Sponsored Products may be admitted');
  if (batch.validation.planFingerprint !== batch.plan.fingerprint) fail('Approval checks must bind the exact plan');
  const creates = batch.plan.nodes.filter((node) => node.effect === 'irreversible_create');
  if (creates.some((node) => !('state' in node.payload) || node.payload.state !== 'paused' || node.rollback !== 'none')) {
    fail('Created resources must start paused and have no delete rollback');
  }
  if (JSON.stringify(batch.plan.nodes.map((node) => node.nodeId)) !== JSON.stringify(orderCampaignCreationNodes(batch.plan.nodes).map((node) => node.nodeId))) {
    fail('Creation nodes must use the canonical dependency order');
  }
  const expected = batch.lineage?.nodeIds ?? creates.map((node) => node.nodeId);
  if (new Set(expected).size !== expected.length || batch.nodes.length !== expected.length
    || JSON.stringify(batch.nodes.map((node) => node.nodeId)) !== JSON.stringify(creates.filter((node) => expected.includes(node.nodeId)).map((node) => node.nodeId))) fail('Parsed and loaded nodes must match the exact ordered approval');
  for (const row of batch.nodes) {
    if (!creates.some((node) => node.nodeId === row.nodeId && node.fingerprint === row.nodeFingerprint)) fail('Node fingerprint mismatch');
    if (row.result !== null && (row.result.planId !== batch.plan.id || row.result.executionId !== batch.id)) fail('Result execution mismatch');
    if (row.intent === null && row.observation !== null && batch.lineage === null) fail('Only an approved retry may observe before its own create');
  }
  const checks = batch.plan.nodes.filter((node) => node.effect === 'read_check');
  if (checks.length !== batch.productChecks.length || new Set(batch.productChecks.map((row) => row.nodeId)).size !== checks.length
    || checks.some((node) => node.kind !== 'eligibility.require_product' || !batch.productChecks.some((row) => row.nodeId === node.nodeId && row.providerEntityId === node.payload.asin))) fail('Product checks must cover the exact plan');
  if (Date.parse(batch.admittedAt) < Date.parse(batch.plan.frozenAt) || Date.parse(batch.expiresAt) > Date.parse(batch.plan.expiresAt)
    || Date.parse(batch.expiresAt) <= Date.parse(batch.admittedAt)) fail('Approval must be within the frozen plan lifetime');
  if (batch.productChecks.some((check) => Date.parse(check.observedAt) > Date.parse(batch.admittedAt))
    || Date.parse(batch.validation.checkedAt) > Date.parse(batch.admittedAt)) fail('Approval evidence cannot come from the future');
  if (batch.lineage) {
    const lineage = batch.lineage;
    if (lineage.parentBatchId === batch.id || lineage.planFingerprint !== batch.plan.fingerprint) fail('Retry must name its original plan and parent batch');
    const inherited = lineage.inheritedResources;
    if (new Set(inherited.map((row) => row.nodeId)).size !== inherited.length
      || inherited.length + expected.length !== creates.length
      || inherited.some((row) => expected.includes(row.nodeId) || !creates.some((node) => node.nodeId === row.nodeId && node.fingerprint === row.nodeFingerprint))) fail('Retry must account separately for every inherited resource');
  }
});
export type CampaignCreationBatch = z.infer<typeof CampaignCreationBatch>;
export const CampaignCreationClaim = z.object({ batchId: Uuid, leaseId: Uuid }).strict();
export type CampaignCreationClaim = z.infer<typeof CampaignCreationClaim>;
export const CampaignCreationReservation = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('dispatch_once'), intent: CampaignCreationBatchIntent }).strict(),
  z.object({ kind: z.enum(['stale', 'already_reserved', 'refused', 'pending']) }).strict(),
]);
export type CampaignCreationReservation = z.infer<typeof CampaignCreationReservation>;

export function campaignCreationBatchSummary(batch: CampaignCreationBatch) {
  const rows = batch.nodes;
  const attempted = rows.filter((row) => row.intent !== null).length;
  const providerSucceeded = rows.filter((row) => row.result?.outcome === 'succeeded').length;
  const adopted = rows.filter((row) => row.observation?.observation === 'observed' && row.result?.outcome !== 'succeeded').length;
  const succeeded = providerSucceeded + adopted;
  const failed = rows.filter((row) => row.result?.outcome === 'authoritative_rejected').length;
  const observed = rows.filter((row) => row.observation?.observation === 'observed').length;
  const refused = rows.filter((row) => row.refusal === 'gate_closed' || row.refusal === 'expired').length;
  const blocked = rows.filter((row) => row.refusal === 'dependency_failed').length;
  const attention = rows.filter((row) => ['uncertain', 'ambiguous_readback', 'conflict'].includes(row.observation?.observation ?? '')).length;
  const pending = rows.filter((row) => row.intent === null && row.refusal === null
    && !['observed', 'uncertain', 'ambiguous_readback', 'conflict'].includes(row.observation?.observation ?? '')).length;
  const uncertain = rows.filter((row) => row.intent !== null && row.result?.outcome !== 'authoritative_rejected'
    && row.result?.outcome !== 'succeeded' && row.observation?.observation !== 'observed').length;
  const unresolved = rows.filter((row) => row.intent !== null && row.result?.outcome !== 'authoritative_rejected'
    && !['observed', 'conflict', 'uncertain', 'ambiguous_readback'].includes(row.observation?.observation ?? '')).length;
  const conflicts = rows.filter((row) => row.observation?.observation === 'conflict').length;
  const terminal = pending === 0 && unresolved === 0;
  const state: CampaignCreationBatchState = terminal && attention > 0 ? 'needs_attention'
    : attempted === 0 && pending === rows.length ? 'admitted'
    : pending > 0 ? 'attempted' : !terminal ? succeeded === rows.length ? 'succeeded' : 'awaiting_observation'
      : observed === rows.length ? 'observed' : succeeded > 0 ? 'partial_failed'
        : failed > 0 ? 'failed' : refused > 0 ? 'refused' : 'blocked';
  return { state, terminal, accounting: { requested: rows.length, parsed: rows.length, loaded: rows.length,
    attempted, providerSucceeded, adopted, succeeded, failed, observed, refused, blocked, pending, uncertain, attention, conflicts },
  failedNodeIds: rows.filter((row) => row.result?.outcome === 'authoritative_rejected').map((row) => row.nodeId) };
}

/** Exact remaining graph shown by retry review and rechecked by admission. */
export function campaignCreationRetrySelection(batch: CampaignCreationBatch) {
  const summary = campaignCreationBatchSummary(batch);
  const rows = batch.nodes.filter((row) => row.observation?.observation !== 'observed');
  const eligible = (row: CampaignCreationBatchNode) => row.observation?.observation === 'uncertain'
    || (row.intent === null && row.refusal === 'dependency_failed')
    || (row.result?.outcome === 'authoritative_rejected' && batch.plan.nodes.some((node) => node.nodeId === row.nodeId
      && node.kind === 'target.create' && node.payload.targetType === 'keyword'));
  const available = summary.terminal && rows.length > 0 && rows.every(eligible)
    && !batch.nodes.some((row) => ['conflict', 'ambiguous_readback'].includes(row.observation?.observation ?? ''));
  const nodeIds = available ? rows.map((row) => row.nodeId) : [];
  return { available, nodeIds, uncertainNodeIds: rows.filter((row) => row.observation?.observation === 'uncertain').map((row) => row.nodeId),
    keywordOnly: nodeIds.length > 0 && nodeIds.every((id) => batch.plan.nodes.some((node) => node.nodeId === id
      && node.kind === 'target.create' && node.payload.targetType === 'keyword')) };
}

/**
 * Exact final controls for a child batch. A keyword-only child keeps the specified keyword retry
 * wording. Any other child recovers resources whose outcome is uncertain or that were never
 * attempted: it is a separate approval with its own label and is never described as keyword creation.
 */
export function campaignCreationRetryControl(selection: Pick<ReturnType<typeof campaignCreationRetrySelection>, 'nodeIds' | 'keywordOnly'>) {
  const count = selection.nodeIds.length;
  return selection.keywordOnly
    ? { kind: 'keyword_retry' as const, count, review: 'Review keyword retry',
      confirm: `Yes, retry ${count} ${count === 1 ? 'keyword' : 'keywords'} in Amazon` }
    : { kind: 'resource_recovery' as const, count, review: 'Review resource recovery',
      confirm: `Yes, recover ${count} ${count === 1 ? 'resource' : 'resources'} in Amazon` };
}

/** Server-owned facts only. A client capability flag never admits a write. */
export function campaignCreationBatchCapability(input: {
  plan: CampaignCreationPlan; executorRegistered: boolean; environmentEnabled: boolean; profileAllowlisted: boolean;
}): { available: boolean; reason: CampaignCreationRefusalCode | null } {
  const reason = input.plan.adProduct !== 'SP' ? 'plan_not_sponsored_products'
    : !input.executorRegistered || input.plan.schemaVersion !== 'openspell.campaign-creation-plan.v2' ? 'executor_unavailable'
      : !input.environmentEnabled ? 'environment_gate_off' : !input.profileAllowlisted ? 'profile_not_allowlisted' : null;
  return { available: reason === null, reason };
}

/** Convert only during save, before validation and display. Never convert an approved artifact. */
export function bindSponsoredProductsCreationPlan(raw: CampaignCreationPlan, scope: CampaignCreationProviderScope,
  hasher: CampaignCreationSha256Hasher): CampaignCreationPlanV2 {
  const plan = verifyCampaignCreationPlanFingerprints(raw, hasher);
  if (plan.adProduct !== 'SP') throw new Error('Only Sponsored Products can bind this provider scope');
  if (plan.schemaVersion === 'openspell.campaign-creation-plan.v2') {
    if (JSON.stringify(plan.providerScope) !== JSON.stringify(CampaignCreationProviderScope.parse(scope))) throw new Error('Frozen provider scope changed');
    return plan;
  }
  const nodes = plan.nodes.map((node) => {
    let payload: unknown = node.payload;
    if (node.kind === 'campaign.create') {
      const { startDate, endDate, ...rest } = node.payload;
      payload = { ...rest, schedule: { type: 'calendar_dates', startDate, endDate } };
    } else if (node.kind === 'ad_group.create') payload = { ...node.payload, settings: { product: 'SP' } };
    const converted = CampaignCreationNodeV2.parse({ ...node, schemaVersion: 'openspell.campaign-creation-node.v2', payload });
    return { ...converted, fingerprint: hasher.digest(serializeCampaignCreationNodeFingerprint(converted)) };
  });
  const converted = CampaignCreationPlanV2.parse({ ...plan, schemaVersion: 'openspell.campaign-creation-plan.v2', providerScope: scope, nodes });
  return CampaignCreationPlanV2.parse({ ...converted, fingerprint: hasher.digest(serializeCampaignCreationPlanFingerprint(converted)) });
}
