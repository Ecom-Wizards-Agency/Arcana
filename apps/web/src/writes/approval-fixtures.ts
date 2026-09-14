import { SpWriteRecordedPreview } from '@wizard-ads/shared/sp-write-application';
import { SpWritePreviewEvidence, serializeSpWritePreviewGuardrails, serializeSpWritePreviewProvenance } from '@wizard-ads/shared/sp-write-preview-evidence';
import {
  SpWriteAction, SpWritePlan, serializeSpWriteActionFingerprint,
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
