import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OptimizerOperationRow } from '@wizard-ads/shared/sp-write-application';
import { SpWritePlan, SpWriteObservation, SpWriteProviderCallIntent, SpWriteProviderResult,
  SpWritePreDispatchDisposition } from '@wizard-ads/shared/sp-writes';
import type { QueryHandle } from '../client.js';
import { getRecommendationRun, listRecommendationWindow, type RecommendationRecord, type RecommendationRunDetail } from './recommendations.js';
import { assertOptimizerApplyBatch, optimizerOperationRows, optimizerRunNarrative, readOptimizerReview } from './optimizer-run.js';

vi.mock('./recommendations.js', () => ({ getRecommendationRun: vi.fn(), listRecommendationWindow: vi.fn() }));

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hash = 'a'.repeat(64);
const now = '2026-09-15T08:00:00.000Z';
const scope = { orgId: id(1), profileId: id(2), batchId: id(3) };
const plan = SpWritePlan.parse({
  schemaVersion: 'openspell.sp-write-plan.v1', id: id(4), orgId: scope.orgId, profileId: scope.profileId,
  providerScope: { amazonProfileId: 'synthetic-provider', connectionId: id(5), region: 'NA',
    marketplaceId: 'synthetic-market', currencyCode: 'USD', apiDialect: 'sp_v3' },
  direction: 'forward', source: { kind: 'apply_batch', applyBatchId: id(6),
    guardrailSnapshotFingerprint: hash, provenanceSnapshotFingerprint: hash },
  generatedAt: now, frozenAt: now, expiresAt: '2026-09-15T08:15:00.000Z',
  actions: [0, 1].map((index) => ({ actionId: id(10 + index), routeKey: 'sp.v3.keywords.update',
    entity: { keywordId: `synthetic-keyword-${index}` },
    sources: [{ kind: 'apply_row', applyRowId: id(20 + index), changeKey: 'keyword.bid' }],
    changes: { bid: { expected: { amount: '1.27', currencyCode: 'USD' }, requested: { amount: '0.83', currencyCode: 'USD' } } }, fingerprint: hash })),
  counts: { logicalChanges: 2, providerRows: 2, uniqueEntities: 2, byRoute: { 'sp.v3.campaigns.update': 0,
    'sp.v3.ad_groups.update': 0, 'sp.v3.keywords.update': 2, 'sp.v3.targets.update': 0, 'sp.v3.product_ads.update': 0 } }, fingerprint: hash,
});
const identity = { planId: plan.id, planFingerprint: hash, approvalId: id(30), executionId: id(31), generation: id(32) };
const intent = SpWriteProviderCallIntent.parse({ ...identity, schemaVersion: 'openspell.sp-write-provider-call-intent.v1',
  intentId: id(33), providerCallId: id(34), routeKey: 'sp.v3.keywords.update', attemptNumber: 1,
  dispatchLeaseId: id(35), providerObservationFingerprint: hash, requestFingerprint: hash, recordedAt: now,
  positions: plan.actions.map((action, requestIndex) => ({ requestIndex, actionId: action.actionId,
    actionFingerprint: hash, amazonEntityId: `synthetic-keyword-${requestIndex}`, actionRequestFingerprint: hash })), fingerprint: hash });
function result(outcomes: Array<'accepted' | 'authoritative_rejected' | 'ambiguous'>) {
  return SpWriteProviderResult.parse({ schemaVersion: 'openspell.sp-write-provider-result.v1', resultId: id(36),
    intentId: intent.intentId, intentFingerprint: hash, providerCallId: intent.providerCallId, requestFingerprint: hash,
    completedAt: now, positions: outcomes.map((outcome, requestIndex) => ({ requestIndex,
      actionId: plan.actions[requestIndex]!.actionId, actionFingerprint: hash, actionRequestFingerprint: hash, outcome,
      providerEntityId: outcome === 'ambiguous' ? null : `synthetic-keyword-${requestIndex}`, code: null, message: null })), fingerprint: hash });
}
function observation(index: number, outcome: 'observed_requested' | 'observed_expected_after_ambiguous' | 'conflict') {
  return SpWriteObservation.parse({ ...identity, schemaVersion: 'openspell.sp-write-observation.v1', observationId: id(40 + index),
    intentId: intent.intentId, intentFingerprint: hash, providerCallId: intent.providerCallId, requestFingerprint: hash,
    actionId: plan.actions[index]!.actionId, actionFingerprint: hash, routeKey: 'sp.v3.keywords.update',
    sourceSyncJobId: id(43), observedAt: now, outcome, observed: { routeKey: 'sp.v3.keywords.update',
      actionId: plan.actions[index]!.actionId, actionFingerprint: hash, amazonEntityId: `synthetic-keyword-${index}`,
      values: { bid: { amount: outcome === 'observed_requested' ? '0.83' : '1.27', currencyCode: 'USD' } } }, fingerprint: hash });
}
const emptyEvidence = { plan, providerCallIntents: [], providerResults: [], observations: [], predispatchDispositions: [] };

it('requires every staged row to belong to the requested optimizer batch', async () => {
  const sql = vi.fn().mockResolvedValueOnce([{ total: 2, owned: 2 }])
    .mockResolvedValueOnce([{ total: 2, owned: 1 }]).mockResolvedValueOnce([{ total: 0, owned: 0 }]);
  const handle = { sql } as unknown as QueryHandle;
  const input = { ...scope, applyBatchId: id(6) };
  await expect(assertOptimizerApplyBatch(handle, input)).resolves.toBeUndefined();
  await expect(assertOptimizerApplyBatch(handle, input)).rejects.toThrow();
  await expect(assertOptimizerApplyBatch(handle, input)).rejects.toThrow();
  expect(sql.mock.calls[0]?.slice(1)).toEqual([scope.batchId, input.applyBatchId, scope.orgId, scope.profileId, input.applyBatchId]);
});

describe('optimizer operation evidence', () => {
  it('keeps pending and sending rows unresolved without treating either as applied', () => {
    const pending = optimizerOperationRows(emptyEvidence);
    expect(pending.map((row) => row.status)).toEqual(['pending', 'pending']);
    expect(pending.every((row) => row.observed === null && !row.retryEligible)).toBe(true);
    const sending = optimizerOperationRows({ ...emptyEvidence, providerCallIntents: [intent] });
    expect(sending.map((row) => row.status)).toEqual(['sending', 'sending']);
    expect(sending.every((row) => row.providerOutcome === 'ambiguous' && !row.retryEligible)).toBe(true);
  });

  it('preserves exact values and source identities and retries only the rejected row', () => {
    const rows = optimizerOperationRows({ ...emptyEvidence, providerCallIntents: [intent], providerResults: [result(['accepted', 'authoritative_rejected'])] });
    expect(rows[0]).toMatchObject({ before: '1.27', requested: '0.83', observed: null, status: 'accepted', retryEligible: false,
      applyRowIds: [id(20)], retryReason: 'The earlier successful change will not be sent again.' });
    expect(rows[1]).toMatchObject({ status: 'failed', retryEligible: true, applyRowIds: [id(21)] });
    expect(rows.filter((row) => row.retryEligible).flatMap((row) => row.applyRowIds)).toEqual([id(21)]);
    expect(OptimizerOperationRow.safeParse({ ...rows[0], retryEligible: true }).success).toBe(false);
  });

  it('waits for pending siblings and incomplete responses before exposing a retry population', () => {
    const firstIntent = { ...intent, positions: intent.positions.slice(0, 1) };
    const rejected = result(['authoritative_rejected']);
    const pending = optimizerOperationRows({ ...emptyEvidence, providerCallIntents: [firstIntent], providerResults: [rejected] });
    expect(pending.map((row) => [row.status, row.retryEligible])).toEqual([['failed', false], ['pending', false]]);
    const sending = optimizerOperationRows({ ...emptyEvidence, providerCallIntents: [intent], providerResults: [rejected] });
    expect(sending.map((row) => [row.status, row.retryEligible])).toEqual([['failed', false], ['sending', false]]);
    expect(sending[0]?.retryReason).toContain('remaining sends and provider responses');
  });

  it('distinguishes accepted from observed in sync', () => {
    const rows = optimizerOperationRows({ ...emptyEvidence, providerCallIntents: [intent],
      providerResults: [result(['accepted', 'accepted'])], observations: [observation(0, 'observed_requested')] });
    expect(rows.map((row) => [row.status, row.observed, row.retryEligible])).toEqual([
      ['observed', '0.83', false], ['accepted', null, false],
    ]);
  });

  it('keeps expected-value observation after ambiguity unresolved without retry authority', () => {
    const evidence = { ...emptyEvidence, providerCallIntents: [intent], providerResults: [result(['ambiguous', 'ambiguous'])] };
    expect(optimizerOperationRows(evidence).every((row) => !row.retryEligible)).toBe(true);
    const rows = optimizerOperationRows({ ...evidence, observations: [observation(0, 'observed_requested'), observation(1, 'observed_expected_after_ambiguous')] });
    expect(rows.map((row) => row.retryEligible)).toEqual([false, false]);
    expect(rows[0]?.status).toBe('observed');
    expect(rows[1]?.status).toBe('ambiguous');
  });

  it('refuses blind retries on a conflicting observation', () => {
    const rows = optimizerOperationRows({ ...emptyEvidence, providerCallIntents: [intent],
      providerResults: [result(['ambiguous', 'accepted'])], observations: [observation(0, 'conflict')] });
    expect(rows[0]).toMatchObject({ status: 'conflict', retryEligible: false });
  });

  it('requires fresh evaluation for stale-state refusals without claiming an attempt', () => {
    const refusal = SpWritePreDispatchDisposition.parse({ ...identity,
      schemaVersion: 'openspell.sp-write-predispatch-disposition.v1', dispositionId: id(44), actionId: plan.actions[0]!.actionId,
      actionFingerprint: hash, recordedAt: now, outcome: 'refused_before_dispatch', reason: 'stale_expected_state',
      providerObservationFingerprint: hash, fingerprint: hash });
    expect(optimizerOperationRows({ ...emptyEvidence, predispatchDispositions: [refusal] })[0]).toMatchObject({
      status: 'refused', providerOutcome: null, retryEligible: false,
    });
  });
});

const diagnostics = { targetsRead: 2, targetsConsidered: 2, proposed: 1, suppressed: 0, declined: 1, blockedOutOfStock: 0,
  skippedInactive: 0, skippedMissingStrategy: 0, corridorsAvailable: 0, corridorsMissing: 2,
  preconditionNotes: 0, declinedReasons: { no_clicks: 1 } };
const hold = { reason: 'INSUFFICIENT_EVIDENCE', prose: 'Synthetic evidence is not sufficient.',
  affectedScope: [{ profileId: scope.profileId, adProduct: 'SP', entityType: 'keyword', entityId: 'synthetic-retained', campaignId: 'synthetic-campaign' }],
  reconsiderWhen: 'Review after more completed reporting days.' };
const run: RecommendationRunDetail = { id: id(50), orgId: scope.orgId, profileId: scope.profileId,
  status: 'succeeded', lookbackDays: 7, windowStart: '2026-09-01', windowEnd: '2026-09-07', engineVersion: 'synthetic',
  proposalsCount: 1, createdAt: new Date(now), finishedAt: new Date(now), groupId: null, groupRole: null, groupSnapshot: null,
  dueAt: null, scheduleContext: null, strategySnapshot: null,
  counts: { proposed: 1, accepted: 0, dismissed: 0, exported: 0, applied: 0, superseded: 0 } };
const proposal: RecommendationRecord = { id: id(51), runId: run.id, orgId: scope.orgId, profileId: scope.profileId,
  reason: 'high_acos', entityType: 'keyword', entityId: 'synthetic-keyword', entityName: 'Synthetic keyword', adProduct: 'SP',
  campaignId: 'synthetic-campaign', adGroupId: null, campaignName: 'Synthetic campaign', adGroupName: null,
  campaignPortfolioId: null, campaignKnown: true, field: 'bid', currentValue: 1.27, proposedValue: 0.83,
  inputs: { rpc: null, clicks: 0, cvrSourceLevel: 'keyword', ceilingApplied: null, capClamped: false },
  status: 'proposed', decidedBy: null, decidedAt: null, exportBatchId: null, exportBatchTag: null, decisionNote: null, createdAt: new Date(now) };

function handle(rosterOverride?: unknown[]) {
  const sql = vi.fn().mockResolvedValueOnce([{ id: scope.batchId, scope_count: 1, child_count: 1, execution_snapshot: null }])
    .mockResolvedValueOnce(rosterOverride ?? [{ run_id: run.id, scope_count: 1, campaign_ids: ['synthetic-campaign'],
      narrative: { diagnostics, holds: [hold] } }]);
  return { sql } as unknown as QueryHandle;
}

describe('complete optimizer review read', () => {
  beforeEach(() => {
    vi.mocked(getRecommendationRun).mockResolvedValue(run);
    vi.mocked(listRecommendationWindow).mockResolvedValue({ rows: [proposal], population: { loaded: 1, total: 1, limit: 20_000, truncated: false } });
  });
  it('returns every proposal, child, retained hold and exact diagnostic count', async () => {
    const review = await readOptimizerReview(handle(), scope);
    expect(review?.proposals).toEqual([proposal]);
    expect(review?.children[0]?.holds).toEqual([hold]);
    expect(review?.children[0]?.diagnostics).toEqual(diagnostics);
    expect(review?.integrity).toMatchObject({ expectedChildren: 1, loadedChildren: 1, loadedCampaigns: 1, loadedProposals: 1 });
    expect(review?.totals).toMatchObject({ proposals: 1, evaluated: 2, retainedHolds: 1, unchanged: null, blocked: null });
    expect(listRecommendationWindow).toHaveBeenCalledWith(expect.anything(), { orgId: scope.orgId, profileId: scope.profileId, runId: run.id });
  });
  it('refuses a missing child or a silently truncated proposal population', async () => {
    await expect(readOptimizerReview(handle([]), scope)).rejects.toThrow('does not reconcile');
    vi.mocked(listRecommendationWindow).mockResolvedValue({ rows: [proposal], population: { loaded: 1, total: 2, limit: 1, truncated: true } });
    await expect(readOptimizerReview(handle(), scope)).rejects.toThrow('does not reconcile');
  });
  it('refuses a child from another profile', async () => {
    vi.mocked(getRecommendationRun).mockResolvedValue({ ...run, profileId: id(90) });
    await expect(readOptimizerReview(handle(), scope)).rejects.toThrow('does not reconcile');
  });
  it('does not substitute zero for missing historical evaluation evidence', async () => {
    const review = await readOptimizerReview(handle([{ run_id: run.id, scope_count: 1,
      campaign_ids: ['synthetic-campaign'], narrative: null }]), scope);
    expect(review?.totals.evaluated).toBeNull();
    expect(review?.totals.retainedHolds).toBeNull();
    expect(review?.children[0]?.evidenceAvailable).toBe(false);
  });
  it('preserves bounded examples without claiming that they are the evaluated population', () => {
    const example = { entity: 'synthetic-retained', outcome: 'held', detail: 'Synthetic retained bid' };
    expect(optimizerRunNarrative({ diagnostics: { ...diagnostics, targetsRead: 70, examples: [example] }, holds: [] }))
      .toMatchObject({ diagnostics: { targetsRead: 70 }, examples: [example] });
    expect(() => optimizerRunNarrative({ diagnostics: { targetsRead: 'missing' } })).toThrow('does not reconcile');
    expect(optimizerRunNarrative({ qualitative: [], decisions: [], oneTimeConfiguration: {} }))
      .toMatchObject({ diagnostics: null, evidenceAvailable: false, holdsComplete: false });
  });

  it('derives the partition only from the complete recorded evaluator outcome roster', async () => {
    const reference = { id: 'sp.reference-efficiency', version: 'reference.1' };
    const targetOutcomes = [{ entityRef: { ...hold.affectedScope[0], entityId: proposal.entityId }, currentBid: 1.27,
      method: reference, outcome: 'suggestion', reasonCode: 'high_acos', reason: 'Synthetic suggestion' },
    { entityRef: hold.affectedScope[0], currentBid: null, method: reference, outcome: 'unchanged', reasonCode: 'no_clicks', reason: hold.prose, hold }];
    const review = await readOptimizerReview(handle([{ run_id: run.id, scope_count: 1, campaign_ids: ['synthetic-campaign'],
      narrative: { diagnostics, holds: [hold], targetOutcomes } }]), scope);
    expect(review?.totals).toMatchObject({ evaluated: 2, suggestions: 1, unchanged: 1, blocked: 0 });
    expect(review?.children[0]?.unchanged).toEqual([targetOutcomes[1]]);
    expect(review?.children[0]?.blocked).toEqual([]);
    expect(() => optimizerRunNarrative({ diagnostics, targetOutcomes: [targetOutcomes[0]] })).toThrow('does not reconcile');
    expect(() => optimizerRunNarrative({ diagnostics, targetOutcomes: [targetOutcomes[0], targetOutcomes[0]] })).toThrow('does not reconcile');
  });

  it('retains the saved ungrouped method admission without substituting current settings', async () => {
    const methodAdmission = { version: 1, admittedAt: now, methodId: 'sp.reference-efficiency', methodVersion: 'reference.1',
      strategyProvenance: {}, experiments: [], campaignMethods: { 'synthetic-campaign': { id: 'sp.coordinated-efficiency', version: 'candidate.1' } } };
    const review = await readOptimizerReview(handle([{ run_id: run.id, scope_count: 1, campaign_ids: ['synthetic-campaign'],
      narrative: null, method_admission: methodAdmission }]), scope);
    expect(review?.children[0]?.run.scheduleContext).toBeNull();
    expect(review?.children[0]?.methodAdmission).toEqual(methodAdmission);
  });
});
