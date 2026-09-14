import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { serializeApplyRows } from './apply.js';
import {
  SpCompleteCampaignBiddingState, SpWriteAction, SpWritePlan, SpWriteObservedAction, SpMutableState,
  orderSpWriteActions, serializeSpWriteActionFingerprint, serializeSpWritePlanFingerprint,
  verifySpWritePlanFingerprints,
} from './sp-writes.js';
import {
  SpWriteDependencyPreviewEvidence, serializeSpWritePreviewGuardrails,
  serializeSpWritePreviewProvenance, verifySpWriteDependencyPreviewEvidenceArtifacts,
} from './sp-write-preview-evidence.js';

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const hasher = { algorithm: 'sha256' as const, digest: (text: string) => createHash('sha256').update(text).digest('hex') };
const zeroHash = '0'.repeat(64);
const baseline = SpCompleteCampaignBiddingState.parse({
  strategy: 'manual',
  placements: { topOfSearch: 100, productPages: 0, restOfSearch: 0, amazonBusiness: null },
  shopperCohorts: [], offAmazonBudgetControlStrategy: null,
});
const afterTop = SpCompleteCampaignBiddingState.parse({
  ...baseline, placements: { ...baseline.placements, topOfSearch: 300 },
});
const afterRest = SpCompleteCampaignBiddingState.parse({
  ...afterTop, placements: { ...afterTop.placements, restOfSearch: 100 },
});

function fingerprintAction(raw: unknown): SpWriteAction {
  const action = SpWriteAction.parse(raw);
  return { ...action, fingerprint: hasher.digest(serializeSpWriteActionFingerprint(action)) };
}

function fingerprintPlan(raw: unknown): SpWritePlan {
  const plan = SpWritePlan.parse(raw);
  return { ...plan, fingerprint: hasher.digest(serializeSpWritePlanFingerprint(plan)) };
}

function fixture() {
  const actions = [
    fingerprintAction({ actionId: id(11), routeKey: 'sp.v3.keywords.update', entity: { keywordId: 'synthetic-keyword' },
      changes: { bid: { expected: { amount: '0.62', currencyCode: 'USD' }, requested: { amount: '0.31', currencyCode: 'USD' } } },
      sources: [{ kind: 'apply_row', applyRowId: id(21), changeKey: 'keyword.bid' }], fingerprint: zeroHash }),
    fingerprintAction({ actionId: id(12), routeKey: 'sp.v3.campaigns.update', entity: { campaignId: 'synthetic-campaign' },
      changes: { placement: { expected: baseline, requested: afterTop, approvedPlacementKeys: ['top_of_search'] } },
      sources: [{ kind: 'apply_row', applyRowId: id(22), changeKey: 'campaign.placement.top_of_search' }], fingerprint: zeroHash }),
    fingerprintAction({ actionId: id(13), routeKey: 'sp.v3.campaigns.update', entity: { campaignId: 'synthetic-campaign' },
      changes: { placement: { expected: afterTop, requested: afterRest, approvedPlacementKeys: ['rest_of_search'] } },
      sources: [{ kind: 'apply_row', applyRowId: id(23), changeKey: 'campaign.placement.rest_of_search' }], fingerprint: zeroHash }),
  ];
  const sourceRows = actions.map((_action, index) => ({
    applyRowId: id(21 + index), recommendationId: id(7), runId: id(8),
    dependencySetId: 'synthetic-dependency', dependencyStepIndex: index,
    method: { methodId: 'sp.coordinated-efficiency', methodVersion: 'candidate.1',
      traceSha256: hasher.digest('synthetic trace'), settingSourcesSha256: hasher.digest('synthetic settings') },
  }));
  const reasons = ['Reduce the base before raising placements.', 'Observe the top-of-search change before the next placement.'];
  const dependencySetText = JSON.stringify({ id: 'synthetic-dependency', campaignId: 'synthetic-campaign',
    changes: [
      { control: 'target_bid', entityRef: { profileId: id(3), campaignId: 'synthetic-campaign', entityType: 'keyword', entityId: 'synthetic-keyword' }, current: 0.62, proposed: 0.31, unit: 'currency_per_click' },
      { control: 'placement_adjustment', entityRef: { profileId: id(3), campaignId: 'synthetic-campaign', entityType: 'campaign', entityId: 'synthetic-campaign' }, placementKey: 'top_of_search', current: 100, proposed: 300, unit: 'percentage' },
      { control: 'placement_adjustment', entityRef: { profileId: id(3), campaignId: 'synthetic-campaign', entityType: 'campaign', entityId: 'synthetic-campaign' }, placementKey: 'rest_of_search', current: 0, proposed: 100, unit: 'percentage' },
    ], precedenceReasons: reasons });
  const calculationSnapshotText = JSON.stringify({ runId: id(8), profileId: id(3),
    methodId: 'sp.coordinated-efficiency', methodVersion: 'candidate.1',
    campaignEvidence: { campaignId: 'synthetic-campaign', currentControls: baseline } });
  const artifactText = serializeApplyRows([
    { entityType: 'keyword', entityId: 'synthetic-keyword', field: 'bid', old: 0.62, new: 0.31 },
    { entityType: 'campaign', entityId: 'synthetic-campaign', field: 'tos_modifier', old: 100, new: 300 },
    { entityType: 'campaign', entityId: 'synthetic-campaign', field: 'ros_modifier', old: 0, new: 100 },
  ]);
  const providerScope = { amazonProfileId: 'synthetic-profile', connectionId: id(4), region: 'NA',
    marketplaceId: 'synthetic-market', currencyCode: 'USD', apiDialect: 'sp_v3' };
  const evidence = SpWriteDependencyPreviewEvidence.parse({
    schemaVersion: 'openspell.sp-write-preview-evidence.v3', planId: id(1),
    guardrails: { profileGrantId: id(5), profileGrantVersion: id(6), providerScope,
      maximumProviderRows: 500, requireCurrentValueMatch: true,
      policies: sourceRows.map((row) => ({ applyRowId: row.applyRowId, recommendationId: row.recommendationId,
        runId: row.runId, strategySnapshotText: JSON.stringify({ schema: 'wizard-ads.tenant-strategy.v1',
          pacing: {}, opt_groups: {}, rank_lifecycle: {}, staged_apply: {}, bids: {}, sv_bands: {}, caps: {}, pat_split: {}, naming: {} }),
        strategyGoal: 'neutral', groupId: null, groupSnapshotText: null })),
    },
    provenance: { applyBatchId: id(9), artifactText, artifactSha256: hasher.digest(artifactText),
      exportedAt: '2026-09-05T12:00:00.000Z', tag: 'synthetic', optGroup: 'synthetic', lever: 'coordinated',
      note: 'Synthetic dependency contract', rows: sourceRows,
      dependencySets: [{ dependencySetId: 'synthetic-dependency', recommendationId: id(7),
        dependencySetText, dependencySetSha256: hasher.digest(dependencySetText),
        calculationSnapshotText, calculationSnapshotSha256: hasher.digest(calculationSnapshotText) }],
    },
  });
  const plan = fingerprintPlan({ schemaVersion: 'openspell.sp-write-plan.v3', id: id(1), orgId: id(2), profileId: id(3),
    providerScope, direction: 'forward', source: { kind: 'apply_batch', applyBatchId: id(9),
      guardrailSnapshotFingerprint: hasher.digest(serializeSpWritePreviewGuardrails(evidence)),
      provenanceSnapshotFingerprint: hasher.digest(serializeSpWritePreviewProvenance(evidence)) },
    generatedAt: '2026-09-05T12:00:01.000Z', frozenAt: '2026-09-05T12:00:02.000Z', expiresAt: '2026-09-05T12:15:01.000Z',
    actions, counts: { logicalChanges: 3, providerRows: 3, uniqueEntities: 2,
      byRoute: { 'sp.v3.campaigns.update': 2, 'sp.v3.ad_groups.update': 0,
        'sp.v3.keywords.update': 1, 'sp.v3.targets.update': 0, 'sp.v3.product_ads.update': 0 } },
    dependencySets: [{ dependencySetId: 'synthetic-dependency', recommendationId: id(7),
      dependencySetSha256: hasher.digest(dependencySetText), actionIds: actions.map((action) => action.actionId), precedenceReasons: reasons }],
    fingerprint: zeroHash,
  });
  return { plan, evidence };
}

describe('v3 ordered dependency plan contracts', () => {
  it('preserves three ordered actions across two entities, including repeated campaign steps', () => {
    const { plan, evidence } = fixture();
    const verified = verifySpWriteDependencyPreviewEvidenceArtifacts(plan, evidence, hasher);
    expect(verified).toEqual({ plan, evidence });
    expect(plan.actions.map((action) => action.actionId)).toEqual([id(11), id(12), id(13)]);
    expect(plan.counts).toMatchObject({ logicalChanges: 3, providerRows: 3, uniqueEntities: 2 });
    expect(plan.dependencySets![0]!.actionIds).toEqual(plan.actions.map((action) => action.actionId));
    expect(evidence.provenance.rows.map((row) => row.dependencyStepIndex)).toEqual([0, 1, 2]);
    const placements = plan.actions.filter((action) => action.routeKey === 'sp.v3.campaigns.update');
    expect(placements).toHaveLength(2);
    expect(placements[1]!.changes.placement!.expected).toEqual(placements[0]!.changes.placement!.requested);
    expect(SpWritePlan.safeParse({ ...plan, counts: { ...plan.counts, uniqueEntities: 3 } }).success).toBe(false);
  });

  it.each(['openspell.sp-write-plan.v1', 'openspell.sp-write-plan.v2'])('refuses these repeated campaign actions under %s', (schemaVersion) => {
    const { plan } = fixture();
    const historical = { ...plan, schemaVersion, dependencySets: undefined, actions: orderSpWriteActions(plan.actions) };
    expect(SpWritePlan.safeParse(historical).success).toBe(false);
  });

  it('refuses reordered actions and group identities against the frozen plan and source', () => {
    const { plan, evidence } = fixture();
    const reordered = { ...plan, actions: [plan.actions[1]!, plan.actions[0]!, plan.actions[2]!] };
    expect(SpWritePlan.safeParse(reordered).success).toBe(false);
    const renamed = { ...plan, dependencySets: [{ ...plan.dependencySets![0]!, dependencySetId: 'renamed-dependency' }] };
    expect(() => verifySpWritePlanFingerprints(renamed, hasher)).toThrow('plan fingerprint mismatch');
    expect(() => verifySpWriteDependencyPreviewEvidenceArtifacts(fingerprintPlan(renamed), evidence, hasher)).toThrow();
    const wrongOwner = { ...plan, dependencySets: [{ ...plan.dependencySets![0]!, recommendationId: id(99) }] };
    expect(() => verifySpWriteDependencyPreviewEvidenceArtifacts(fingerprintPlan(wrongOwner), evidence, hasher)).toThrow();
  });

  it('requires the full placement state left by the preceding action', () => {
    const { plan } = fixture();
    const last = plan.actions[2]!;
    if (last.routeKey !== 'sp.v3.campaigns.update' || last.changes.placement === undefined) throw new Error('Expected placement fixture');
    const changes = [
      { strategy: 'auto_for_sales' as const },
      { shopperCohorts: [{ shopperCohortType: 'synthetic-cohort', percentage: 17, audienceSegments: [] }] },
      { offAmazonBudgetControlStrategy: 'synthetic-offsite-limit' },
      { placements: { ...afterTop.placements, topOfSearch: 299 } },
    ];
    for (const change of changes) {
      const expected = SpCompleteCampaignBiddingState.parse({ ...afterTop, ...change });
      const requested = SpCompleteCampaignBiddingState.parse({ ...expected, placements: { ...expected.placements, restOfSearch: 100 } });
      const altered = fingerprintAction({ ...last, changes: { placement: { ...last.changes.placement, expected, requested } } });
      expect(SpWriteAction.safeParse(altered).success).toBe(true);
      const parsed = SpWritePlan.safeParse({ ...plan, actions: [...plan.actions.slice(0, 2), altered] });
      expect(parsed.success).toBe(false);
      if (!parsed.success) expect(parsed.error.issues.map((issue) => issue.message)).toContain('each placement step must start from the complete state left by its predecessor');
    }
  });

  it('refuses a second change to one control even with a valid consecutive state', () => {
    const { plan } = fixture();
    const last = plan.actions[2]!;
    const repeated = fingerprintAction({ ...last,
      changes: { placement: { expected: afterTop, requested: { ...afterTop, placements: { ...afterTop.placements, topOfSearch: 350 } }, approvedPlacementKeys: ['top_of_search'] } },
      sources: [{ kind: 'apply_row', applyRowId: id(23), changeKey: 'campaign.placement.top_of_search' }],
    });
    const parsed = SpWritePlan.safeParse({ ...plan, actions: [...plan.actions.slice(0, 2), repeated] });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues.map((issue) => issue.message)).toContain('a dependency set cannot repeat a control');
  });

  it('requires complete dependency metadata and per-step source method evidence', () => {
    const { plan, evidence } = fixture();
    const set = plan.dependencySets![0]!;
    const invalidPlans = [
      { ...plan, dependencySets: undefined },
      { ...plan, dependencySets: [] },
      { ...plan, dependencySets: [{ ...set, dependencySetSha256: undefined }] },
      { ...plan, dependencySets: [{ ...set, precedenceReasons: [] }] },
      { ...plan, dependencySets: [{ ...set, actionIds: set.actionIds.slice(0, 2) }] },
    ];
    for (const invalid of invalidPlans) expect(SpWritePlan.safeParse(invalid).success).toBe(false);
    for (const missing of [{ method: undefined }, { dependencyStepIndex: undefined }, { dependencySetId: undefined }]) {
      expect(SpWriteDependencyPreviewEvidence.safeParse({ ...evidence, provenance: { ...evidence.provenance,
        rows: [{ ...evidence.provenance.rows[0]!, ...missing }, ...evidence.provenance.rows.slice(1)],
      } }).success).toBe(false);
    }
  });

  it('keeps the v1 action fingerprint format and binds changed source order separately', () => {
    const { plan, evidence } = fixture();
    if (plan.source.kind !== 'apply_batch') throw new Error('Expected forward source fixture');
    const actionFingerprints = plan.actions.map((action) => action.fingerprint);
    for (const action of plan.actions) {
      const { fingerprint, ...fields } = action;
      const historicalPreimage = JSON.stringify(['openspell.sp-write-action.v1', fields]);
      expect(serializeSpWriteActionFingerprint(action)).toBe(historicalPreimage);
      expect(fingerprint).toBe(hasher.digest(historicalPreimage));
    }
    const order = [0, 2, 1];
    const reordered = SpWriteDependencyPreviewEvidence.parse({ ...evidence,
      guardrails: { ...evidence.guardrails, policies: order.map((index) => evidence.guardrails.policies[index]!) },
      provenance: { ...evidence.provenance,
        rows: order.map((index, dependencyStepIndex) => ({ ...evidence.provenance.rows[index]!, dependencyStepIndex })) },
    });
    expect(hasher.digest(serializeSpWritePreviewProvenance(reordered))).not.toBe(plan.source.provenanceSnapshotFingerprint);
    expect(() => verifySpWriteDependencyPreviewEvidenceArtifacts(plan, reordered, hasher)).toThrow();
    const rebound = fingerprintPlan({ ...plan, source: { ...plan.source,
      guardrailSnapshotFingerprint: hasher.digest(serializeSpWritePreviewGuardrails(reordered)),
      provenanceSnapshotFingerprint: hasher.digest(serializeSpWritePreviewProvenance(reordered)) } });
    expect(rebound.actions.map((action) => action.fingerprint)).toEqual(actionFingerprints);
    expect(rebound.fingerprint).not.toBe(plan.fingerprint);
    expect(() => verifySpWriteDependencyPreviewEvidenceArtifacts(rebound, reordered, hasher)).toThrow();
  });
});

// Archived presence is evidence of a conflict, even when former controls are omitted.
it.each(['sp.v3.targets.update', 'sp.v3.campaigns.update'])('retains archived presence for %s without allowing an archived mutation', (routeKey) => {
  const observed = { routeKey, actionId: id(41), actionFingerprint: zeroHash, amazonEntityId: 'synthetic-archived',
    values: { state: 'archived' } };
  expect(SpWriteObservedAction.parse(observed)).toEqual(observed);
  expect(SpWriteObservedAction.safeParse({ ...observed, values: {} }).success).toBe(false);
  expect(SpWriteObservedAction.safeParse({ ...observed, values: { state: 'unknown' } }).success).toBe(false);
  expect(SpMutableState.safeParse('archived').success).toBe(false);
});
