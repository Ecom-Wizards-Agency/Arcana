import { describe, expect, it } from 'vitest';
import { CampaignCreationBatchRequest, CampaignCreationRefusalCode, CampaignCreationBatchState,
  CampaignCreationBatch, CampaignCreationBatchObservation, campaignCreationRetrySelection, campaignCreationBatchSummary, campaignCreationBatchCapability,
  CampaignCreationRetryReviewRequest, campaignCreationRetryControl } from './campaign-creation-batch.js';
import { CampaignCreationAdmissionValidation, campaignCreationReviewExpiresAt, campaignCreationReviewExpired, campaignCreationCheckOutcomesAgree } from './campaign-creation-admission.js';
import { CampaignBuilderCheck } from './campaign-builder.js';
import { CampaignCreationNodeKind, CampaignCreationProviderResult, type CampaignCreationPlan } from './campaign-creation.js';

const id = '00000000-0000-4000-8000-000000000001';
const request = { action: 'create', profileId: id, draftId: id, expectedRevision: 2, planFingerprint: 'a'.repeat(64) };
describe('creation batch admission contracts', () => {
  it('requires the exact draft, revision and displayed fingerprint', () => {
    expect(CampaignCreationBatchRequest.parse(request)).toEqual(request);
    for (const field of ['draftId', 'expectedRevision', 'planFingerprint']) {
      const incomplete = { ...request }; delete incomplete[field as keyof typeof incomplete];
      expect(CampaignCreationBatchRequest.safeParse(incomplete).success).toBe(false);
    }
    expect(CampaignCreationBatchRequest.safeParse({ ...request, expectedRevision: 0 }).success).toBe(false);
  });
  it('requires parent lineage and a unique nonempty exact retry subset', () => {
    const retry = { ...request, action: 'retry', parentBatchId: id, nodeIds: [id] };
    expect(CampaignCreationBatchRequest.parse(retry)).toEqual(retry);
    expect(CampaignCreationBatchRequest.safeParse({ ...retry, nodeIds: [] }).success).toBe(false);
    expect(CampaignCreationBatchRequest.safeParse({ ...retry, nodeIds: [id, id] }).success).toBe(false);
    expect(CampaignCreationBatchRequest.safeParse({ ...retry, parentBatchId: undefined }).success).toBe(false);
  });
  it('retains every stable refusal and lifecycle state', () => {
    const codes = ['stale_fingerprint', 'stale_revision', 'draft_not_validated', 'blocking_check', 'freshness_not_current',
      'environment_gate_off', 'profile_not_allowlisted', 'executor_unavailable', 'plan_not_sponsored_products',
      'not_found', 'invalid_request', 'authorization_refused', 'retry_not_allowed', 'provider_scope_changed', 'ambiguous_readback'];
    expect(codes.map((code) => CampaignCreationRefusalCode.parse(code))).toEqual(CampaignCreationRefusalCode.options);
    expect(CampaignCreationBatchState.options).toEqual(['requested', 'admitted', 'attempted', 'succeeded', 'failed',
      'partial_failed', 'observed', 'awaiting_observation', 'refused', 'blocked', 'needs_attention']);
  });
  it('fails closed outside either gate and for historical or unsupported plans', () => {
    // Only the two fields used by this capability are material to these boundary cases.
    const plan = { schemaVersion: 'openspell.campaign-creation-plan.v2', adProduct: 'SP' } as CampaignCreationPlan;
    const input = { plan, executorRegistered: true, environmentEnabled: true, profileAllowlisted: true };
    expect(campaignCreationBatchCapability(input)).toEqual({ available: true, reason: null });
    for (const flag of ['executorRegistered', 'environmentEnabled', 'profileAllowlisted'] as const) {
      expect(campaignCreationBatchCapability({ ...input, [flag]: false }).available).toBe(false);
    }
    expect(campaignCreationBatchCapability({ ...input, plan: { ...plan, adProduct: 'SB' } }).reason).toBe('plan_not_sponsored_products');
  });
});

function admittedCampaign(): CampaignCreationBatch {
  const at = '2026-09-15T12:00:00.000Z';
  const expiresAt = '2026-09-15T13:00:00.000Z';
  const hash = 'a'.repeat(64);
  const node = { schemaVersion: 'openspell.campaign-creation-node.v2', nodeId: id, kind: 'campaign.create',
    adProduct: 'SP', apiDialect: 'sp_legacy_v3', dependsOn: [], fingerprint: hash,
    effect: 'irreversible_create', rollback: 'none', payload: {
      name: 'Synthetic campaign', state: 'paused', budget: { amount: 20, type: 'daily', currencyCode: 'USD' },
      schedule: { type: 'calendar_dates', startDate: '2026-09-15', endDate: null }, portfolioId: null,
      settings: { product: 'SP', targetingType: 'manual', biddingStrategy: 'manual',
        placementBidding: { topOfSearch: 0, productPages: 0, restOfSearch: 0 } },
    } };
  return CampaignCreationBatch.parse({ id, draftId: id, draftRevision: 2, actorId: id, admittedAt: at, expiresAt,
    environmentGateVersion: id, profileGrantVersion: id, lineage: null, productChecks: [],
    validation: { planFingerprint: hash, recipeFingerprint: hash, checkedAt: at,
      checks: CampaignBuilderCheck.shape.id.options.map((id) => ({ id, label: id, source: 'Synthetic measurement',
        status: 'passed', blocking: false, currentValue: 'Synthetic value', requiredAction: '' })) },
    plan: { schemaVersion: 'openspell.campaign-creation-plan.v2', id, orgId: id, profileId: id,
      adProduct: 'SP', apiDialect: 'sp_legacy_v3', marketplaceId: 'ATVPDKIKX0DER',
      providerScope: { amazonProfileId: '900000000001', connectionId: id, region: 'NA',
        marketplaceId: 'ATVPDKIKX0DER', currencyCode: 'USD', accountType: 'seller' },
      generatedAt: at, frozenAt: at, expiresAt, nodes: [node], fingerprint: hash,
      counts: { totalNodes: 1, readChecks: 0, irreversibleCreates: 1,
        byKind: Object.fromEntries(CampaignCreationNodeKind.options.map((kind) => [kind, kind === 'campaign.create' ? 1 : 0])) },
      noRollbackAcknowledgement: { required: true, rollback: 'none', compensatingAction: 'separate_reviewed_pause_or_archive' } },
    nodes: [{ nodeId: id, nodeFingerprint: hash, intent: null, result: null, observation: null, refusal: null }],
  });
}
describe('creation lifecycle accounting', () => {
  it('reconciles an admitted request, durable attempt, acceptance and exact observation', () => {
    const batch = admittedCampaign(); const node = batch.nodes[0]!;
    expect(campaignCreationBatchSummary(batch)).toMatchObject({ state: 'admitted', accounting: { requested: 1, parsed: 1, loaded: 1, attempted: 0 } });
    node.intent = { id, requestDigest: 'b'.repeat(64), nodeRequestDigest: 'c'.repeat(64), reservedAt: batch.admittedAt,
      deadline: '2026-09-15T12:00:35.000Z' };
    expect(campaignCreationBatchSummary(CampaignCreationBatch.parse(batch))).toMatchObject({ state: 'awaiting_observation', terminal: false,
      accounting: { attempted: 1, uncertain: 1, succeeded: 0, failed: 0, observed: 0 } });
    node.result = CampaignCreationProviderResult.parse({ effect: 'irreversible_create', planId: id, nodeId: id, executionId: id,
      attemptId: id, providerCallId: id, nodeFingerprint: node.nodeFingerprint, requestIndex: 0,
      requestDigest: node.intent.requestDigest, nodeRequestDigest: node.intent.nodeRequestDigest,
      outcome: 'succeeded', providerEntityId: '29001', providerEntityVersion: null, providerCode: null,
      sanitizedMessage: null, providerRequestId: null, responseDigest: 'd'.repeat(64), startedAt: batch.admittedAt, completedAt: batch.admittedAt });
    expect(campaignCreationBatchSummary(CampaignCreationBatch.parse(batch))).toMatchObject({ state: 'succeeded', terminal: false,
      accounting: { attempted: 1, succeeded: 1, observed: 0, uncertain: 0 } });
    node.observation = { ...readEvidence(batch), mode: 'provider_id', providerEntityId: '29001', requestDigest: node.intent.requestDigest };
    expect(campaignCreationBatchSummary(CampaignCreationBatch.parse(batch))).toMatchObject({ state: 'observed', terminal: true,
      accounting: { parsed: 1, loaded: 1, attempted: 1, succeeded: 1, failed: 0, observed: 1 } });
    expect(CampaignCreationBatch.safeParse({ ...batch, nodes: [] }).success).toBe(false);
    expect(CampaignCreationBatch.safeParse({ ...batch, nodes: [{ ...node, observation: { ...node.observation, providerEntityId: '29002' } }] }).success).toBe(false);
  });
  it('records gate refusal without claiming a provider attempt', () => {
    const batch = admittedCampaign(); batch.nodes[0]!.refusal = 'gate_closed';
    expect(campaignCreationBatchSummary(CampaignCreationBatch.parse(batch))).toMatchObject({ state: 'refused', terminal: true,
      accounting: { requested: 1, parsed: 1, attempted: 0, succeeded: 0, failed: 0, refused: 1 } });
  });
});

function readEvidence(batch: CampaignCreationBatch): CampaignCreationBatchObservation {
  return { id, mode: 'identity', identityFingerprint: 'a'.repeat(64), providerEntityId: '29001',
    requestDigest: 'b'.repeat(64), responseDigest: 'c'.repeat(64), observation: 'observed', complete: true,
    accounting: { pages: 1, loaded: 1, parsed: 1, matched: 1 }, startedAt: batch.admittedAt,
    observedAt: batch.admittedAt, reason: null };
}
describe('explicit recovery and unknown listing checks', () => {
  it('admits exactly one of every check with truthful nonblocking listing unknowns', () => {
    const validation = admittedCampaign().validation;
    for (const check of validation.checks) if (['stock', 'buy-box', 'suppression', 'moderation'].includes(check.id)) check.status = 'not_measured';
    expect(CampaignCreationAdmissionValidation.safeParse(validation).success).toBe(true);
    expect(CampaignCreationAdmissionValidation.safeParse({ ...validation, checks: validation.checks.slice(1) }).success).toBe(false);
    expect(CampaignCreationAdmissionValidation.safeParse({ ...validation, checks: [...validation.checks, validation.checks[0]] }).success).toBe(false);
    validation.checks[0]!.blocking = true;
    expect(CampaignCreationAdmissionValidation.safeParse(validation).success).toBe(false);
  });
  it('adopts an existing resource in an approved child without inventing a POST', () => {
    const batch = admittedCampaign(); batch.id = '00000000-0000-4000-8000-000000000002';
    batch.lineage = { parentBatchId: id, planFingerprint: batch.plan.fingerprint, nodeIds: [id], inheritedResources: [] };
    batch.nodes[0]!.observation = readEvidence(batch);
    batch.nodes[0]!.observations = [batch.nodes[0]!.observation];
    expect(campaignCreationBatchSummary(CampaignCreationBatch.parse(batch))).toMatchObject({ state: 'observed', terminal: true,
      accounting: { attempted: 0, providerSucceeded: 0, adopted: 1, succeeded: 1, observed: 1 } });
    expect(CampaignCreationBatch.safeParse({ ...batch, nodes: batch.nodes.map((node) => ({ ...node, refusal: 'gate_closed' })) }).success).toBe(false);
  });
  it('offers an uncertain campaign as an exact separately approved retry and refuses ambiguity', () => {
    const batch = admittedCampaign(); const row = batch.nodes[0]!;
    row.intent = { id, requestDigest: 'b'.repeat(64), nodeRequestDigest: 'c'.repeat(64), reservedAt: batch.admittedAt, deadline: batch.expiresAt };
    row.observation = { ...readEvidence(batch), providerEntityId: null, observation: 'uncertain',
      accounting: { pages: 1, loaded: 0, parsed: 0, matched: 0 }, reason: 'No match in two complete observations at least 60 seconds apart.' };
    expect(campaignCreationBatchSummary(CampaignCreationBatch.parse(batch))).toMatchObject({ state: 'needs_attention', terminal: true });
    expect(campaignCreationRetrySelection(batch)).toMatchObject({ available: true, nodeIds: [id], keywordOnly: false });
    row.observation = { ...row.observation, observation: 'ambiguous_readback', accounting: { pages: 1, loaded: 2, parsed: 2, matched: 2 } };
    expect(campaignCreationRetrySelection(CampaignCreationBatch.parse(batch)).available).toBe(false);
  });
  it('never treats an incomplete or unaccounted scan as absence or uniqueness', () => {
    const read = readEvidence(admittedCampaign());
    expect(CampaignCreationBatchObservation.safeParse({ ...read, complete: false }).success).toBe(false);
    expect(CampaignCreationBatchObservation.safeParse({ ...read, accounting: { pages: 1, loaded: 2, parsed: 1, matched: 1 } }).success).toBe(false);
  });
});

it('bounds queued creation authority by the current check window and frozen plan expiry',()=>{
  expect(campaignCreationReviewExpiresAt('2026-09-15T13:00:00.000Z','2026-09-15T12:00:00.000Z')).toBe('2026-09-15T12:05:00.000Z');
  expect(campaignCreationReviewExpiresAt('2026-09-15T12:01:00.000Z','2026-09-15T12:00:00.000Z')).toBe('2026-09-15T12:01:00.000Z');
});

describe('displayed review evidence binding', () => {
  it('expires displayed evidence at its five-minute deadline or the frozen plan expiry, whichever is first', () => {
    const checkedAt = '2026-09-15T12:00:00.000Z';
    const planExpiresAt = '2026-09-15T13:00:00.000Z';
    expect(campaignCreationReviewExpired(planExpiresAt, checkedAt, Date.parse('2026-09-15T12:04:59.999Z'))).toBe(false);
    expect(campaignCreationReviewExpired(planExpiresAt, checkedAt, Date.parse('2026-09-15T12:05:00.000Z'))).toBe(true);
    expect(campaignCreationReviewExpired(planExpiresAt, checkedAt, Date.parse('2026-09-15T12:10:00.000Z'))).toBe(true);
    expect(campaignCreationReviewExpired('2026-09-15T12:01:00.000Z', checkedAt, Date.parse('2026-09-15T12:01:00.000Z'))).toBe(true);
    expect(campaignCreationReviewExpired(planExpiresAt, 'not a time', Date.parse(checkedAt))).toBe(true);
  });
  it('treats the displayed evidence as current only while every check keeps its outcome', () => {
    const checks = admittedCampaign().validation.checks;
    expect(campaignCreationCheckOutcomesAgree(checks, [...checks].reverse())).toBe(true);
    expect(campaignCreationCheckOutcomesAgree(checks, checks.map((check) => ({ ...check, currentValue: 'Later value' })))).toBe(true);
    expect(campaignCreationCheckOutcomesAgree(checks, checks.map((check, index) => index ? check : { ...check, status: 'blocked', blocking: true }))).toBe(false);
    expect(campaignCreationCheckOutcomesAgree(checks, checks.slice(1))).toBe(false);
  });
  it('binds a retry review refresh to the exact draft revision, fingerprint and parent batch', () => {
    const review = { profileId: id, draftId: id, expectedRevision: 3, planFingerprint: 'a'.repeat(64), parentBatchId: id };
    expect(CampaignCreationRetryReviewRequest.parse(review)).toEqual(review);
    for (const field of ['draftId', 'expectedRevision', 'planFingerprint', 'parentBatchId']) {
      const incomplete = { ...review }; delete incomplete[field as keyof typeof incomplete];
      expect(CampaignCreationRetryReviewRequest.safeParse(incomplete).success).toBe(false);
    }
    expect(CampaignCreationRetryReviewRequest.safeParse({ ...review, nodeIds: [id] }).success).toBe(false);
  });
  it('keeps the exact keyword retry label and gives resource recovery its own separate control', () => {
    const keyword = '00000000-0000-4000-8000-000000000003';
    expect(campaignCreationRetryControl({ nodeIds: [keyword], keywordOnly: true })).toEqual({ kind: 'keyword_retry', count: 1,
      review: 'Review keyword retry', confirm: 'Yes, retry 1 keyword in Amazon' });
    expect(campaignCreationRetryControl({ nodeIds: [keyword, id], keywordOnly: true }).confirm).toBe('Yes, retry 2 keywords in Amazon');
    const recovery = campaignCreationRetryControl({ nodeIds: [id, keyword, '00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000005'], keywordOnly: false });
    expect(recovery).toEqual({ kind: 'resource_recovery', count: 4, review: 'Review resource recovery', confirm: 'Yes, recover 4 resources in Amazon' });
    expect(recovery.confirm).not.toMatch(/keyword|retry/);
    expect(campaignCreationRetryControl({ nodeIds: [id], keywordOnly: false }).confirm).toBe('Yes, recover 1 resource in Amazon');
    const batch = admittedCampaign(); const row = batch.nodes[0]!;
    row.intent = { id, requestDigest: 'b'.repeat(64), nodeRequestDigest: 'c'.repeat(64), reservedAt: batch.admittedAt, deadline: batch.expiresAt };
    row.observation = { ...readEvidence(batch), providerEntityId: null, observation: 'uncertain',
      accounting: { pages: 1, loaded: 0, parsed: 0, matched: 0 }, reason: 'No match in two complete observations at least 60 seconds apart.' };
    expect(campaignCreationRetryControl(campaignCreationRetrySelection(CampaignCreationBatch.parse(batch)))).toMatchObject({
      kind: 'resource_recovery', confirm: 'Yes, recover 1 resource in Amazon' });
  });
});
