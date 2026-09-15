import { OptimizerOperation, SpWriteOperationDetail, SpWriteRecordedPreview, SpWriteRestoreExportPreview } from '@wizard-ads/shared/sp-write-application';
import { SpWritePreviewEvidence, serializeSpWritePreviewGuardrails, serializeSpWritePreviewProvenance } from '@wizard-ads/shared/sp-write-preview-evidence';
import {
  SpWriteAction, SpWritePlan, SpWriteObservation, type SpWriteAccounting, type SpWriteExecutionStatus, serializeSpWriteActionFingerprint,
  serializeSpWritePlanFingerprint, spWritePlanBinding,
} from '@wizard-ads/shared/sp-writes';

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const ZERO = '0'.repeat(64);
async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Synthetic presentation data only. No production page imports this fixture module. */
export async function spWriteApprovalFixtures() {
  const frozenAt = '2026-09-06T12:00:00.000Z';
  const scope = { amazonProfileId: 'synthetic-profile', connectionId: id(4), region: 'NA',
    marketplaceId: 'synthetic-marketplace', currencyCode: 'USD', apiDialect: 'sp_v3' };
  const sourceRow = { applyRowId: id(5), recommendationId: id(6), runId: id(7) };
  const artifactText = JSON.stringify([{ entity_type: 'keyword', entity_id: 'synthetic-keyword',
    field: 'bid', old: '0.9', new: '0.7' }]);
  const evidence = SpWritePreviewEvidence.parse({
    schemaVersion: 'openspell.sp-write-preview-evidence.v1', planId: id(1),
    guardrails: { profileGrantId: id(2), profileGrantVersion: id(3), providerScope: scope,
      maximumProviderRows: 500, requireCurrentValueMatch: true,
      policies: [{ ...sourceRow, strategySnapshotText: JSON.stringify({
        schema: 'wizard-ads.tenant-strategy.v1', pacing: {}, opt_groups: {}, rank_lifecycle: {},
        staged_apply: {}, bids: {}, sv_bands: {}, caps: {}, pat_split: {}, naming: {},
      }), strategyGoal: 'neutral', groupId: null, groupSnapshotText: null }] },
    provenance: { applyBatchId: id(8), artifactText, artifactSha256: await digest(artifactText),
      exportedAt: frozenAt, tag: 'Synthetic review', optGroup: 'synthetic', lever: 'bid-down',
      note: 'Synthetic approval-screen example', rows: [sourceRow] },
  });
  const action = SpWriteAction.parse({ actionId: id(9), routeKey: 'sp.v3.keywords.update',
    entity: { keywordId: 'synthetic-keyword' },
    sources: [{ kind: 'apply_row', applyRowId: sourceRow.applyRowId, changeKey: 'keyword.bid' }],
    changes: { bid: { expected: { amount: '0.9', currencyCode: 'USD' }, requested: { amount: '0.7', currencyCode: 'USD' } } },
    fingerprint: ZERO });
  action.fingerprint = await digest(serializeSpWriteActionFingerprint(action));
  const plan = SpWritePlan.parse({ schemaVersion: 'openspell.sp-write-plan.v1',
    id: id(1), orgId: id(10), profileId: id(11), providerScope: scope, direction: 'forward',
    source: { kind: 'apply_batch', applyBatchId: id(8),
      guardrailSnapshotFingerprint: await digest(serializeSpWritePreviewGuardrails(evidence)),
      provenanceSnapshotFingerprint: await digest(serializeSpWritePreviewProvenance(evidence)) },
    generatedAt: frozenAt, frozenAt, expiresAt: '2026-09-06T12:15:00.000Z', actions: [action],
    counts: { logicalChanges: 1, providerRows: 1, uniqueEntities: 1, byRoute: {
      'sp.v3.campaigns.update': 0, 'sp.v3.ad_groups.update': 0, 'sp.v3.keywords.update': 1,
      'sp.v3.targets.update': 0, 'sp.v3.product_ads.update': 0,
    } }, fingerprint: ZERO });
  plan.fingerprint = await digest(serializeSpWritePlanFingerprint(plan));
  const ready = SpWriteRecordedPreview.parse({
    preview: { plan, binding: spWritePlanBinding(plan), evidence },
    profile: { id: plan.profileId, label: 'Synthetic profile', currencyCode: 'USD' },
    currentRows: [{ actionId: action.actionId, entityName: 'Synthetic keyword', syncedAt: frozenAt,
      observation: { actionId: action.actionId, actionFingerprint: action.fingerprint,
        routeKey: action.routeKey, amazonEntityId: 'synthetic-keyword',
        values: { bid: { amount: '0.9', currencyCode: 'USD' }, state: 'enabled' } } }],
    freshness: { checkedAt: frozenAt, status: 'current', reasons: [] }, admission: null,
  });
  const stale = structuredClone(ready);
  stale.freshness = { checkedAt: frozenAt, status: 'stale', reasons: ['current_value_changed'] };
  const observation = stale.currentRows[0]!.observation;
  if (observation?.routeKey !== 'sp.v3.keywords.update') throw new Error('Synthetic keyword observation missing');
  observation.values.bid = { amount: '1.1', currencyCode: 'USD' };
  const unavailable = structuredClone(ready);
  unavailable.currentRows[0]!.observation = null;
  unavailable.freshness = { checkedAt: frozenAt, status: 'unavailable', reasons: ['entity_unavailable'] };
  const queued = structuredClone(ready);
  queued.admission = { kind: 'queued', operation: { executionId: id(12), planId: plan.id },
    approvalId: id(13), approvalRequestId: id(14) };
  const inverseAction = SpWriteAction.parse({ ...action, actionId: id(16),
    sources: [{ kind: 'inverse_action', sourceActionId: action.actionId, changeKey: 'keyword.bid' }],
    changes: { bid: { expected: { amount: '0.7', currencyCode: 'USD' }, requested: { amount: '0.9', currencyCode: 'USD' } } },
    fingerprint: ZERO });
  inverseAction.fingerprint = await digest(serializeSpWriteActionFingerprint(inverseAction));
  const inversePlan = SpWritePlan.parse({ ...plan, id: id(15), direction: 'inverse',
    source: { kind: 'inverse_execution', sourceExecutionId: id(12), sourcePlanId: plan.id,
      sourcePlanFingerprint: plan.fingerprint }, actions: [inverseAction], fingerprint: ZERO });
  inversePlan.fingerprint = await digest(serializeSpWritePlanFingerprint(inversePlan));
  const inverse = SpWriteRecordedPreview.parse({ ...ready,
    preview: { plan: inversePlan, binding: spWritePlanBinding(inversePlan), evidence: null },
    currentRows: [{ ...ready.currentRows[0], actionId: inverseAction.actionId,
      observation: { ...ready.currentRows[0]!.observation, actionId: inverseAction.actionId,
        actionFingerprint: inverseAction.fingerprint,
        values: { bid: { amount: '0.7', currencyCode: 'USD' }, state: 'enabled' } } }],
  });
  return {
    ready, inverse, stale: SpWriteRecordedPreview.parse(stale),
    unavailable: SpWriteRecordedPreview.parse(unavailable), queued: SpWriteRecordedPreview.parse(queued),
    lostResponse: [{ status: 503, body: { code: 'outcome_unknown' } },
      { status: 200, body: queued.admission }],
  };
}

/** Reconciled result fixtures for saved-operation presentation tests. */
type OperationResultRow = Pick<OptimizerOperation['rows'][number], 'actionId' | 'name' | 'before' | 'requested' | 'observed' | 'status' | 'applyRowIds'> & Partial<Pick<OptimizerOperation['rows'][number], 'retryEligible' | 'retryReason'>>;
export function spWriteResultFixture(count: number, status: SpWriteExecutionStatus, patch: Partial<SpWriteAccounting> = {}) {
  const counts = { logicalChanges: count, providerRows: count, uniqueEntities: count, byRoute: { 'sp.v3.campaigns.update': 0, 'sp.v3.ad_groups.update': 0, 'sp.v3.keywords.update': count, 'sp.v3.targets.update': 0, 'sp.v3.product_ads.update': 0 } };
  const plan = SpWritePlan.parse({ schemaVersion: 'openspell.sp-write-plan.v1', id: id(1), orgId: id(2), profileId: id(3),
    providerScope: { amazonProfileId: 'synthetic-profile', connectionId: id(4), region: 'NA', marketplaceId: 'synthetic-marketplace', currencyCode: 'USD', apiDialect: 'sp_v3' },
    direction: 'forward', source: { kind: 'apply_batch', applyBatchId: id(5), guardrailSnapshotFingerprint: 'a'.repeat(64), provenanceSnapshotFingerprint: 'b'.repeat(64) },
    generatedAt: '2026-07-30T00:00:00.000Z', frozenAt: '2026-07-30T00:00:00.000Z', expiresAt: '2026-07-30T00:15:00.000Z',
    actions: Array.from({ length: count }, (_, index) => ({ actionId: id(20 + index), routeKey: 'sp.v3.keywords.update', entity: { keywordId: `synthetic-target-${index}` }, sources: [{ kind: 'apply_row', applyRowId: id(30 + index), changeKey: 'keyword.bid' }], changes: { bid: { expected: { amount: '0.87', currencyCode: 'USD' }, requested: { amount: '0.69', currencyCode: 'USD' } } }, fingerprint: 'c'.repeat(64) })), counts, fingerprint: 'd'.repeat(64),
  });
  const accounting: SpWriteAccounting = {
    approvedRows: count, pendingDispatch: count, refusedBeforeDispatch: 0, intentCommitted: 0, providerAccepted: 0, providerRejected: 0, providerAmbiguous: 0,
    observedRequested: 0, observedExpectedAfterAmbiguous: 0, observationConflict: 0, observationMissing: 0, pendingObservation: 0, providerCallsCommitted: 0, providerCallsCompleted: 0, ...patch,
  };
  const observations = accounting.observedRequested + accounting.observedExpectedAfterAmbiguous + accounting.observationConflict + accounting.observationMissing;
  const detail = SpWriteOperationDetail.parse({ operation: { executionId: id(6), planId: plan.id }, admission: 'queued',
    receipt: { schemaVersion: 'openspell.sp-write-authorization-receipt.v1', approvalId: id(7), approvalRequestId: id(8), executionId: id(6), generation: id(9), approvalMode: 'manual', plan: spWritePlanBinding(plan), preapprovedInversePlan: null, boundedAuthorization: null, approvedBy: id(10), approvedAt: plan.frozenAt, expiresAt: plan.expiresAt, confirmationVersion: 'openspell.amazon-sp-write-confirmation.v1', gateSnapshot: { environmentGate: 'enabled', environmentGateVersion: id(11), profileGrantId: id(12), profileGrantVersion: id(13), checkedAt: plan.frozenAt, gateSnapshotFingerprint: 'e'.repeat(64) } },
    snapshot: { status, accounting }, mirror: { observations, pending: observations, promoted: 0, alreadyCurrent: 0, superseded: 0, missing: 0 }, original: null, inverses: [],
  });
  const rows: OperationResultRow[] = plan.actions.map((action, index) => ({ actionId: action.actionId, name: `Synthetic target ${index + 1}`, before: '0.87', requested: '0.69', observed: null, status: 'pending', applyRowIds: [id(30 + index)] }));
  return { plan, detail, rows, profileId: plan.profileId, batchId: id(5) };
}

export type SpWriteResultVisualState = 'queued' | 'applying' | 'partial' | 'single' | 'retry' | 'ambiguous';
export function spWriteOperationFixture(state: SpWriteResultVisualState = 'queued'): OptimizerOperation {
  const data = state === 'queued' ? spWriteResultFixture(2, 'queued')
    : state === 'applying' ? spWriteResultFixture(2, 'running', { pendingDispatch: 1, intentCommitted: 1, providerAccepted: 1, pendingObservation: 1, providerCallsCommitted: 1, providerCallsCompleted: 1 })
    : state === 'partial' ? spWriteResultFixture(2, 'partial', { pendingDispatch: 0, intentCommitted: 2, providerAccepted: 1, providerRejected: 1, observedRequested: 1, providerCallsCommitted: 1, providerCallsCompleted: 1 })
    : state === 'single' ? spWriteResultFixture(1, 'awaiting_observation', { pendingDispatch: 0, intentCommitted: 1, providerAccepted: 1, pendingObservation: 1, providerCallsCommitted: 1, providerCallsCompleted: 1 })
    : state === 'retry' ? spWriteResultFixture(1, 'succeeded', { pendingDispatch: 0, intentCommitted: 1, providerAccepted: 1, observedRequested: 1, providerCallsCommitted: 1, providerCallsCompleted: 1 })
    : spWriteResultFixture(1, 'ambiguous', { pendingDispatch: 0, intentCommitted: 1, providerAmbiguous: 1, pendingObservation: 1, providerCallsCommitted: 1 });
  const c = data.detail.snapshot.accounting;
  const rows = data.plan.actions.map((action, index) => {
    const providerOutcome = index < c.providerAccepted ? 'accepted' as const
      : index < c.providerAccepted + c.providerRejected ? 'authoritative_rejected' as const
      : index < c.intentCommitted ? 'ambiguous' as const : null;
    const observation = index >= c.observedRequested ? null : SpWriteObservation.parse({
      schemaVersion: 'openspell.sp-write-observation.v1', observationId: id(60 + index),
      planId: data.plan.id, planFingerprint: data.plan.fingerprint, approvalId: data.detail.receipt.approvalId,
      executionId: data.detail.operation.executionId, generation: data.detail.receipt.generation,
      intentId: id(80), intentFingerprint: 'a'.repeat(64), providerCallId: id(81), requestFingerprint: 'b'.repeat(64),
      actionId: action.actionId, actionFingerprint: action.fingerprint, routeKey: action.routeKey, sourceSyncJobId: id(82),
      observedAt: '2026-07-30T00:02:00.000Z', outcome: 'observed_requested',
      observed: { actionId: action.actionId, actionFingerprint: action.fingerprint, routeKey: action.routeKey,
        amazonEntityId: `synthetic-target-${index}`, values: { bid: { amount: '0.69', currencyCode: 'USD' } } }, fingerprint: 'c'.repeat(64),
    });
    return { ...data.rows[index], action, actionId: action.actionId, providerOutcome, observation, refusal: null,
      observed: observation ? '0.69' : null, reason: null,
      status: observation ? 'observed' : providerOutcome === 'accepted' ? 'accepted' : providerOutcome === 'authoritative_rejected' ? 'failed' : providerOutcome === 'ambiguous' ? 'ambiguous' : 'pending',
      retryEligible: providerOutcome === 'authoritative_rejected', retryReason: providerOutcome === 'accepted' ? 'The earlier successful change will not be sent again.' : providerOutcome === 'authoritative_rejected' ? 'Amazon rejected this row. Review a fresh preview.' : 'Awaiting execution evidence.',
    };
  });
  return OptimizerOperation.parse({ plan: data.plan, detail: data.detail, rows });
}


/** Two fully fingerprinted changes, with matching evidence counts, for confirmation tests. */
export async function spWriteTwoChangeApprovalFixture(first: SpWriteRecordedPreview) {
  const evidence = SpWritePreviewEvidence.parse(structuredClone(first.preview.evidence));
  const source = { applyRowId: id(100), recommendationId: id(101), runId: evidence.provenance.rows[0]!.runId };
  evidence.provenance.rows.push(source);
  evidence.guardrails.policies.push({ ...evidence.guardrails.policies[0]!, ...source });
  const artifact = JSON.parse(evidence.provenance.artifactText) as Record<string, unknown>[];
  artifact.push({ ...artifact[0], entity_id: 'synthetic-second-keyword' });
  evidence.provenance.artifactText = JSON.stringify(artifact); evidence.provenance.artifactSha256 = await digest(evidence.provenance.artifactText);
  const second = SpWriteAction.parse({ ...first.preview.plan.actions[0], actionId: id(102), entity: { keywordId: 'synthetic-second-keyword' }, sources: [{ kind: 'apply_row', applyRowId: source.applyRowId, changeKey: 'keyword.bid' }] });
  second.fingerprint = await digest(serializeSpWriteActionFingerprint(second));
  const plan = SpWritePlan.parse({ ...first.preview.plan, actions: [...first.preview.plan.actions, second],
    source: { ...first.preview.plan.source, guardrailSnapshotFingerprint: await digest(serializeSpWritePreviewGuardrails(evidence)), provenanceSnapshotFingerprint: await digest(serializeSpWritePreviewProvenance(evidence)) },
    counts: { ...first.preview.plan.counts, logicalChanges: 2, providerRows: 2, uniqueEntities: 2, byRoute: { ...first.preview.plan.counts.byRoute, 'sp.v3.keywords.update': 2 } },
  });
  plan.fingerprint = await digest(serializeSpWritePlanFingerprint(plan));
  const firstObserved = first.currentRows[0]!.observation!;
  return SpWriteRecordedPreview.parse({ ...first, preview: { plan, binding: spWritePlanBinding(plan), evidence }, currentRows: [...first.currentRows, { actionId: second.actionId, entityName: 'Synthetic second keyword', syncedAt: plan.frozenAt, observation: { ...firstObserved, actionId: second.actionId, actionFingerprint: second.fingerprint, amazonEntityId: 'synthetic-second-keyword' } }] });
}


/** Synthetic restore evidence for presentation and browser state verification only. */
export function restorePlan(plan: SpWritePlan) {
  if (plan.source.kind !== 'apply_batch') throw new Error('Expected a synthetic apply batch');
  return SpWritePlan.parse({ ...plan, source: { ...plan.source, restoreProposal: {
    kind: 'restore_proposal', sourceBatchId: plan.source.applyBatchId,
    sourceArtifactText: JSON.stringify(plan.actions.map((action) => {
      if (action.routeKey !== 'sp.v3.keywords.update' || !action.changes.bid) throw new Error('Expected a synthetic keyword bid');
      return { entity_type: 'keyword', entity_id: action.entity.keywordId, field: 'bid', old: action.changes.bid.requested.amount, new: action.changes.bid.expected.amount };
    })),
    sourceRowIds: plan.actions.flatMap((action) => action.sources.flatMap((source) => source.kind === 'apply_row' ? [source.applyRowId] : [])),
    rows: plan.actions.map((action) => {
      const source = action.sources[0];
      if (source?.kind !== 'apply_row' || action.routeKey !== 'sp.v3.keywords.update' || !action.changes.bid) throw new Error('Expected a synthetic keyword bid');
      return { sourceRowId: source.applyRowId, entityId: action.entity.keywordId, current: action.changes.bid.expected, readAt: plan.frozenAt, restoreTo: action.changes.bid.requested };
    }),
  } } });
}
export async function restoreApprovalFixture() {
  const original = (await spWriteApprovalFixtures()).ready;
  const plan = restorePlan(original.preview.plan);
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serializeSpWritePlanFingerprint(plan)));
  plan.fingerprint = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return SpWriteRecordedPreview.parse({ ...original, gates: { environmentEnabled: true, profileAllowlisted: true }, preview: { ...original.preview, plan, binding: spWritePlanBinding(plan) } });
}
export type RestoreResultState = SpWriteResultVisualState | 'failed' | 'refused' | 'conflict';
export function restoreOperationFixture(state: RestoreResultState) {
  const original = spWriteOperationFixture(state === 'failed' || state === 'refused' || state === 'conflict' ? 'single' : state);
  original.plan = restorePlan(original.plan);
  if (state === 'failed' || state === 'refused' || state === 'conflict') {
    const row = original.rows[0]!;
    const c = original.detail.snapshot.accounting;
    original.detail.snapshot.status = state;
    c.pendingObservation = 0;
    if (state === 'failed') { c.providerAccepted = 0; c.providerRejected = 1; row.providerOutcome = 'authoritative_rejected'; row.retryEligible = true; }
    if (state === 'refused') {
      c.providerAccepted = 0; c.intentCommitted = 0; c.refusedBeforeDispatch = 1; c.providerCallsCommitted = 0; c.providerCallsCompleted = 0; row.providerOutcome = null; row.retryEligible = false;
      row.refusal = { schemaVersion: 'openspell.sp-write-predispatch-disposition.v1', dispositionId: '11111111-1111-4111-8111-111111111111', planId: original.plan.id, planFingerprint: original.plan.fingerprint, approvalId: original.detail.receipt.approvalId, executionId: original.detail.operation.executionId, generation: original.detail.receipt.generation, actionId: row.actionId, actionFingerprint: row.action.fingerprint, recordedAt: original.plan.frozenAt, outcome: 'refused_before_dispatch', reason: 'stale_expected_state', providerObservationFingerprint: 'b'.repeat(64), fingerprint: 'c'.repeat(64) };
    }
    if (state === 'conflict') {
      c.observationConflict = 1; row.observed = '1.12'; row.reason = 'The current synchronized value changed after Amazon accepted this row.'; row.retryEligible = false;
      row.observation = { ...spWriteOperationFixture('retry').rows[0]!.observation!, outcome: 'conflict' };
      original.detail.mirror = { observations: 1, pending: 1, promoted: 0, alreadyCurrent: 0, superseded: 0, missing: 0 };
    }
    row.status = state;
    row.retryReason = state === 'failed' ? 'Amazon rejected this row. Review a fresh preview.' : 'A fresh source review is required.';
  }
  return OptimizerOperation.parse(original);
}
export async function restoreExportFixture() {
  const recorded = await restoreApprovalFixture();
  const plan = recorded.preview.plan;
  if (plan.source.kind !== 'apply_batch' || !plan.source.restoreProposal) throw new Error('Synthetic restore missing');
  return SpWriteRestoreExportPreview.parse({ kind: 'export_only', profileId: plan.profileId, batchId: plan.source.applyBatchId, fingerprint: 'd'.repeat(64), preview: {
    batchId: plan.source.applyBatchId, sourceBatchId: null, activeReversionBatchId: null, profileId: plan.profileId, tag: 'Synthetic source', optGroup: 'synthetic', lever: 'bid', note: '', lifecycleStatus: 'applied_externally', exportedAt: plan.generatedAt, appliedAt: plan.frozenAt, artifactSha256: 'a'.repeat(64), exportedProposals: 1, reversibleRows: 1, unsupportedRows: 0, readyRows: 1, blockedRows: 0, exportAllowed: true, reason: 'Current synchronized values match the recorded export.',
    rows: plan.source.restoreProposal.rows.map((row) => ({ batchId: plan.source.kind === 'apply_batch' ? plan.source.applyBatchId : '', rowId: row.sourceRowId, recommendationId: null, entityType: 'keyword', entityId: row.entityId, entityName: 'Synthetic restore keyword', field: 'bid', originalValue: row.restoreTo.amount, proposedValue: row.current.amount, exportedValue: row.current.amount, synchronizedValue: row.current.amount, synchronizedAt: row.readAt, currentValue: row.current.amount, currentSyncedAt: row.readAt, inverseValue: row.restoreTo.amount, state: 'ready', conflict: false, exportAllowed: true, reason: 'Untouched since we set it' })),
  } });
}
