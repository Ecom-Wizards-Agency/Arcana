import { describe, expect, it } from 'vitest';
import {
  SpWriteActor,
  SpWriteAdmission,
  SpWriteInversePreviewRequest,
  SpWriteManualApprovalRequest,
  SpWriteConfirmedApprovalRequest,
  SpWriteOperationDetail,
  SpWriteOperationId,
  SpWritePreviewRequest,
  SpWriteRecordedPreview,
  SpWriteRecordedPreviewRequest,
  spWriteExecutionRequirements,
  spWriteRetryEvidenceAllows,
  OptimizerRetryRequest,
  SpWriteRestoreExportPreview,
  SpWriteRestoreExportRequest,
  SpWriteRestoreExportResult,
  spWriteRestoreExportConfirmation,
} from './sp-write-application.js';
import { spWritePlanBinding, SpWritePlan } from './sp-writes.js';

const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, '0')}`;

describe('restore export fallback authority', () => {
  it('binds the exact count and requires a fingerprint and operator note without a write grant', () => {
    const request = { profileId: id('1'), batchId: id('2'), expectedRows: 2, fingerprint: 'a'.repeat(64),
      note: 'Synthetic restore review', confirmation: spWriteRestoreExportConfirmation(2) };
    expect(SpWriteRestoreExportRequest.parse(request)).toEqual(request);
    expect(SpWriteRestoreExportRequest.safeParse({ ...request, confirmation: 'Yes, apply 2 changes to Amazon' }).success).toBe(false);
    expect(SpWriteRestoreExportRequest.safeParse({ ...request, expectedRows: 1 }).success).toBe(false);
    expect(SpWriteRestoreExportRequest.safeParse({ ...request, note: ' ' }).success).toBe(false);
    expect(SpWriteRestoreExportRequest.safeParse({ ...request, fingerprint: undefined }).success).toBe(false);
    expect(SpWriteRestoreExportPreview.safeParse({ kind: 'export_only', profileId: request.profileId,
      batchId: request.batchId, fingerprint: request.fingerprint, preview: {} }).success).toBe(false);
  });
  it('keeps counted export results distinct from Amazon execution', () => {
    const result = { batchId: id('1'), sourceBatchId: id('2'), tag: 'synthetic-restore', rows: 2,
      artifactSha256: 'b'.repeat(64), files: { rows: 'synthetic.rows.tsv' }, downloads: { rows: '/api/recommendations/export/synthetic?format=rows' },
      amazonUpdated: false, guardrail: 'This is a review file only. Arcana did not update Amazon.' };
    expect(SpWriteRestoreExportResult.parse(result)).toEqual(result);
    expect(SpWriteRestoreExportResult.safeParse({ ...result, amazonUpdated: true }).success).toBe(false);
    expect(SpWriteRestoreExportResult.safeParse({ ...result, rows: 0 }).success).toBe(false);
  });
});

function operationFixture() {
  const binding = {
    planId: id('2'), planFingerprint: 'a'.repeat(64), orgId: id('5'), profileId: id('6'),
    providerScope: {
      amazonProfileId: 'synthetic-profile', connectionId: id('7'), region: 'NA',
      marketplaceId: 'synthetic-marketplace', currencyCode: 'USD', apiDialect: 'sp_v3',
    },
    direction: 'forward', expiresAt: '2026-09-05T12:15:00.000Z',
    counts: { logicalChanges: 1, providerRows: 1, uniqueEntities: 1, byRoute: {
      'sp.v3.campaigns.update': 0, 'sp.v3.ad_groups.update': 0, 'sp.v3.keywords.update': 1,
      'sp.v3.targets.update': 0, 'sp.v3.product_ads.update': 0,
    } },
  };
  return {
    operation: { executionId: id('1'), planId: id('2') }, admission: 'approved_pending_start',
    receipt: {
      schemaVersion: 'openspell.sp-write-authorization-receipt.v1',
      approvalId: id('3'), approvalRequestId: id('4'), executionId: id('1'), generation: id('8'),
      approvalMode: 'manual', plan: binding, preapprovedInversePlan: null, boundedAuthorization: null,
      approvedBy: id('9'), approvedAt: '2026-09-05T12:00:00.000Z', expiresAt: binding.expiresAt,
      confirmationVersion: 'openspell.amazon-sp-write-confirmation.v1',
      gateSnapshot: { environmentGate: 'enabled', environmentGateVersion: id('10'), profileGrantId: id('11'), profileGrantVersion: id('12'),
        checkedAt: '2026-09-05T12:00:00.000Z', gateSnapshotFingerprint: 'b'.repeat(64) },
    },
    snapshot: { status: 'queued', accounting: {
      approvedRows: 1, pendingDispatch: 1, refusedBeforeDispatch: 0, intentCommitted: 0,
      providerAccepted: 0, providerRejected: 0, providerAmbiguous: 0, observedRequested: 0,
      observedExpectedAfterAmbiguous: 0, observationConflict: 0, observationMissing: 0,
      pendingObservation: 0, providerCallsCommitted: 0, providerCallsCompleted: 0,
    } }, mirror: { observations: 0, pending: 0, promoted: 0, alreadyCurrent: 0, superseded: 0, missing: 0 },
    original: null, inverses: [],
  };
}

function recordedFixture() {
  const receipt = operationFixture().receipt;
  const plan = SpWritePlan.parse({
    schemaVersion: 'openspell.sp-write-plan.v1', id: id('2'), orgId: id('5'), profileId: id('6'),
    providerScope: receipt.plan.providerScope, direction: 'inverse',
    source: { kind: 'inverse_execution', sourceExecutionId: id('1'), sourcePlanId: id('30'), sourcePlanFingerprint: 'b'.repeat(64) },
    generatedAt: '2026-09-05T12:00:00.000Z', frozenAt: '2026-09-05T12:00:00.000Z', expiresAt: receipt.expiresAt,
    actions: [{ actionId: id('20'), routeKey: 'sp.v3.keywords.update', entity: { keywordId: 'synthetic-keyword' },
      sources: [{ kind: 'inverse_action', sourceActionId: id('21'), changeKey: 'keyword.bid' }],
      changes: { bid: { expected: { amount: '0.9', currencyCode: 'USD' }, requested: { amount: '0.7', currencyCode: 'USD' } } },
      fingerprint: 'c'.repeat(64) }], counts: receipt.plan.counts, fingerprint: receipt.plan.planFingerprint,
  });
  return {
    preview: { plan, binding: spWritePlanBinding(plan), evidence: null },
    profile: { id: plan.profileId, label: 'Synthetic profile', currencyCode: 'USD' },
    currentRows: [{ actionId: id('20'), entityName: 'Synthetic keyword', syncedAt: plan.frozenAt,
      observation: { actionId: id('20'), actionFingerprint: 'c'.repeat(64), routeKey: 'sp.v3.keywords.update',
        amazonEntityId: 'synthetic-keyword', values: { bid: { amount: '0.9', currencyCode: 'USD' }, state: 'enabled' } } }],
    freshness: { checkedAt: plan.frozenAt, status: 'current', reasons: [] }, admission: null,
  };
}

describe('write application boundary', () => {
  it('describes worker prerequisites without treating approval as dispatch enablement', () => {
    expect(spWriteExecutionRequirements).toEqual({
      executor: 'worker',
      dispatchGate: { environmentVariable: 'OPENSPELL_SP_WRITE_DISPATCH_ENABLED', enabledByDefault: false },
      profileAuthorization: 'required',
    });
  });

  it('requires the exact Amazon logical-change count in a confirmed HTTP approval', () => {
    const receipt = operationFixture().receipt;
    const request = {
      profileId: receipt.plan.profileId,
      confirmation: 'Yes, apply 1 changes to Amazon',
      approval: {
        approvalRequestId: receipt.approvalRequestId, plan: receipt.plan, approvalMode: 'manual',
        confirmationVersion: receipt.confirmationVersion, boundedAuthorization: null, preapprovedInversePlan: null,
      },
    };
    expect(SpWriteConfirmedApprovalRequest.safeParse(request).success).toBe(true);
    for (const confirmation of [undefined, '', 'Yes', 'Yes, apply 2 changes to Amazon', 'Yes, apply 1 changes']) {
      expect(SpWriteConfirmedApprovalRequest.safeParse({ ...request, confirmation }).success).toBe(false);
    }
  });
  it('reads only an exact recorded plan identity without accepting caller authority', () => {
    const request = { profileId: id('1'), planId: id('2') };
    expect(SpWriteRecordedPreviewRequest.parse(request)).toEqual(request);
    expect(SpWriteRecordedPreviewRequest.safeParse({ ...request, orgId: id('3') }).success).toBe(false);
    expect(SpWriteRecordedPreviewRequest.safeParse({ profileId: id('1'), applyBatchId: id('2') }).success).toBe(false);
  });

  it('keeps exact decimal frozen values separate from refreshed state, including inverses', () => {
    const fixture = recordedFixture();
    fixture.currentRows[0]!.observation.values.bid.amount = '0.900001';
    const parsed = SpWriteRecordedPreview.parse({ ...fixture,
      freshness: { ...fixture.freshness, status: 'stale', reasons: ['current_value_changed'] } });
    expect(parsed.preview.evidence).toBeNull();
    expect(parsed.preview.plan.actions[0]?.changes).toEqual(fixture.preview.plan.actions[0]?.changes);
    expect(parsed.currentRows[0]?.observation).toMatchObject({ values: { bid: { amount: '0.900001' } } });
  });

  it('requires every current row to bind the same action and rejects incomplete or misleading freshness', () => {
    const fixture = recordedFixture();
    expect(SpWriteRecordedPreview.safeParse(fixture).success).toBe(true);
    for (const currentRows of [[], [fixture.currentRows[0], fixture.currentRows[0]],
      [{ ...fixture.currentRows[0], actionId: id('99') }],
      [{ ...fixture.currentRows[0], observation: { ...fixture.currentRows[0]!.observation, amazonEntityId: 'wrong-keyword' } }]]) {
      expect(SpWriteRecordedPreview.safeParse({ ...fixture, currentRows }).success).toBe(false);
    }
    expect(SpWriteRecordedPreview.safeParse({ ...fixture, currentRows: [{ ...fixture.currentRows[0], observation: null }] }).success).toBe(false);
    expect(SpWriteRecordedPreview.safeParse({ ...fixture,
      freshness: { ...fixture.freshness, status: 'current', reasons: ['expired'] } }).success).toBe(false);
    expect(SpWriteRecordedPreview.safeParse({ ...fixture, admission: {
      kind: 'queued', operation: { executionId: id('1'), planId: id('99') }, approvalId: id('3'), approvalRequestId: id('4'),
    } }).success).toBe(false);
  });
  it('requires a plan identity even when forward and inverse share an execution cycle', () => {
    const forward = SpWriteOperationId.parse({ executionId: id('1'), planId: id('2') });
    const inverse = SpWriteOperationId.parse({ executionId: id('1'), planId: id('3') });
    expect(forward).not.toEqual(inverse);
    expect(SpWriteOperationId.safeParse({ executionId: id('1') }).success).toBe(false);
    expect(SpWriteInversePreviewRequest.parse({
      requestId: id('4'), profileId: id('5'), original: forward,
    }).original).toEqual(forward);
  });

  it('rejects caller-supplied actor and provider authority in preview requests', () => {
    const request = { requestId: id('1'), profileId: id('2'), applyBatchId: id('3') };
    expect(SpWritePreviewRequest.safeParse(request).success).toBe(true);
    for (const extra of [{ userId: id('4') }, { orgId: id('5') }, { writeEnabled: true }]) {
      expect(SpWritePreviewRequest.safeParse({ ...request, ...extra }).success).toBe(false);
    }
    expect(SpWriteActor.safeParse({ orgId: id('1'), userId: 'unverified' }).success).toBe(false);
  });

  it('retains the same operation after approval when enqueue is unresolved', () => {
    const approved = SpWriteAdmission.parse({
      kind: 'approved_pending_start', operation: { executionId: id('1'), planId: id('2') },
      approvalId: id('3'), approvalRequestId: id('4'),
    });
    expect(SpWriteAdmission.parse({ ...approved, kind: 'queued' }).operation).toEqual(approved.operation);
    expect(SpWriteAdmission.safeParse({ ...approved, kind: 'applied' }).success).toBe(false);
    expect(SpWriteAdmission.safeParse({ ...approved, outboxId: id('5') }).success).toBe(false);
  });

  it('binds manual approval to the profile being authorized', () => {
    const receipt = operationFixture().receipt;
    const request = {
      profileId: receipt.plan.profileId,
      approval: {
        approvalRequestId: receipt.approvalRequestId, plan: receipt.plan, approvalMode: 'manual',
        confirmationVersion: receipt.confirmationVersion, boundedAuthorization: null, preapprovedInversePlan: null,
      },
    };
    expect(SpWriteManualApprovalRequest.safeParse(request).success).toBe(true);
    expect(SpWriteManualApprovalRequest.safeParse({ ...request, profileId: id('99') }).success).toBe(false);
  });

  it('refuses status counts and execution facts that disagree with a recorded approval', () => {
    const fixture = operationFixture();
    expect(SpWriteOperationDetail.parse(fixture).operation).toEqual(fixture.operation);
    expect(SpWriteOperationDetail.safeParse({ ...fixture, snapshot: { ...fixture.snapshot, status: 'succeeded' } }).success).toBe(false);
    expect(SpWriteOperationDetail.safeParse({ ...fixture, snapshot: {
      status: 'queued', accounting: { ...fixture.snapshot.accounting, approvedRows: 0, pendingDispatch: 0 },
    } }).success).toBe(false);
    expect(SpWriteOperationDetail.safeParse({ ...fixture, mirror: { ...fixture.mirror, observations: 1, pending: 1 } }).success).toBe(false);
  });

  it('keeps inverse lineage in the same cycle and bound to the original profile', () => {
    const fixture = operationFixture();
    expect(SpWriteOperationDetail.safeParse({ ...fixture, inverses: [{ executionId: id('99'), planId: id('98') }] }).success).toBe(false);
    const inverse = {
      ...fixture, operation: { ...fixture.operation, planId: id('20') },
      original: fixture.operation,
      receipt: { ...fixture.receipt, approvalMode: 'bounded_live_test',
        preapprovedInversePlan: { ...fixture.receipt.plan, planId: id('20'), direction: 'inverse' },
        boundedAuthorization: { authorizationId: id('21'), authorizationFingerprint: 'c'.repeat(64), expiresAt: fixture.receipt.expiresAt },
      },
    };
    expect(SpWriteOperationDetail.parse(inverse).original).toEqual(fixture.operation);
    expect(SpWriteOperationDetail.safeParse({ ...inverse, original: null }).success).toBe(false);
    expect(SpWriteOperationDetail.safeParse({ ...inverse, receipt: { ...inverse.receipt,
      preapprovedInversePlan: { ...inverse.receipt.preapprovedInversePlan, profileId: id('99') },
    } }).success).toBe(false);
  });
});

it('accepts only canonical nonempty forward row sets and requires narrowing with retry origin', () => {
  const request = { requestId: id('1'), profileId: id('2'), applyBatchId: id('3') };
  expect(SpWritePreviewRequest.parse(request)).toEqual(request);
  expect(SpWritePreviewRequest.parse({ ...request, forwardRowIds: [id('4'),id('5')] }).forwardRowIds).toEqual([id('4'),id('5')]);
  const retryOrigin = { executionId:id('6'),planId:id('7'),planFingerprint:'a'.repeat(64) };
  for (const forwardRowIds of [[],[id('5'),id('4')],[id('4'),id('4')],['invalid'],[id('4').replace('4000','A000')]]) {
    expect(SpWritePreviewRequest.safeParse({ ...request,forwardRowIds }).success).toBe(false);
  }
  expect(SpWritePreviewRequest.safeParse({ ...request,retryOrigin }).success).toBe(false);
  expect(SpWritePreviewRequest.safeParse({ ...request,retryOrigin,forwardRowIds:[id('4')] }).success).toBe(true);
  expect(OptimizerRetryRequest.safeParse({requestId:id('1'),profileId:id('2'),batchId:id('3'),original:{executionId:id('6'),planId:id('7')},forwardRowIds:[id('4')]}).success).toBe(false);
});
it('never treats ambiguous expected-state observation as retry authority and requires terminal nonexecution evidence', () => {
  expect(spWriteRetryEvidenceAllows({ refusal:null,providerOutcome:'authoritative_rejected',observation:null })).toBe(true);
  expect(spWriteRetryEvidenceAllows({ refusal:{reason:'environment_gate_closed'},providerOutcome:null,observation:null })).toBe(true);
  for (const providerOutcome of [null,'accepted','ambiguous'] as const) {
    expect(spWriteRetryEvidenceAllows({refusal:null,providerOutcome,observation:null})).toBe(false);
  }
  for (const observation of ['observed_requested','observed_expected_after_ambiguous','conflict','missing'] as const) {
    expect(spWriteRetryEvidenceAllows({refusal:null,providerOutcome:'ambiguous',observation:{outcome:observation}})).toBe(false);
    expect(spWriteRetryEvidenceAllows({refusal:null,providerOutcome:'authoritative_rejected',observation:{outcome:observation}})).toBe(false);
  }
  expect(spWriteRetryEvidenceAllows({refusal:{reason:'stale_expected_state'},providerOutcome:null,observation:null})).toBe(false);
});
