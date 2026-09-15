import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CampaignCreationApprovalSource, CampaignCreationApprovalView,
  CampaignCreationReviewCheck, campaignCreationReviewFreshness } from './campaign-creation-approval.js';
import { CampaignCreationPlanV1, CampaignCreationNodeV1, CampaignCreationPlanV2, CampaignCreationNodeV2, CampaignCreationNodeKind,
  CampaignCreationAuthorizationReceipt, CampaignCreationExecutionEvidence,
  orderCampaignCreationNodes, serializeCampaignCreationNodeFingerprint,
  serializeCampaignCreationPlanFingerprint } from './campaign-creation.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const zero = '0'.repeat(64);
const NOW = '2026-09-06T12:05:00.000Z';
const ref = (kind: string, n: number) => ({ source: 'plan_node', kind, nodeId: id(n) });

function source(): CampaignCreationApprovalSource {
  const base = { schemaVersion: 'openspell.campaign-creation-node.v2', adProduct: 'SD',
    apiDialect: 'sd_legacy', fingerprint: zero };
  const read = { ...base, effect: 'read_check', rollback: 'not_applicable', dependsOn: [] };
  const create = { ...base, effect: 'irreversible_create', rollback: 'none' };
  const raw = [
    { ...read, nodeId: id(10), kind: 'eligibility.require_product', payload: { asin: 'B000000001', sku: 'SYNTHETIC' } },
    { ...read, nodeId: id(11), kind: 'asset.require_existing', payload: { assetId: 'SYNTHETIC-VIDEO', version: '3', purpose: 'video' } },
    { ...create, nodeId: id(12), kind: 'campaign.create', dependsOn: [id(10)], payload: {
      name: 'Synthetic campaign', state: 'paused', budget: { amount: 20, type: 'daily', currencyCode: 'USD' },
      schedule: { type: 'calendar_dates', startDate: '2026-09-07', endDate: null }, portfolioId: null,
      settings: { product: 'SD', tactic: 'contextual', costType: 'cpc' } } },
    { ...create, nodeId: id(13), kind: 'ad_group.create', dependsOn: [id(12)], payload: {
      campaign: ref('campaign', 12), name: 'Synthetic ad group', state: 'paused', defaultBid: 1,
      settings: { product: 'SD', creativeType: 'VIDEO', bidOptimization: 'clicks' } } },
    { ...create, nodeId: id(14), kind: 'ad.create', dependsOn: [id(10), id(13)], payload: {
      format: 'sd_product_ad', adGroup: ref('ad_group', 13), product: ref('product', 10), state: 'paused' } },
    { ...create, nodeId: id(15), kind: 'creative.create', dependsOn: [id(11), id(13), id(14)], payload: {
      format: 'sd_video', adGroup: ref('ad_group', 13), headline: null, brandLogo: null,
      consentToTranslate: false, videos: { representation: 'single_video', video: ref('asset', 11) } } },
  ];
  const nodes = orderCampaignCreationNodes(raw.map((node) => CampaignCreationNodeV2.parse(node)))
    .map((node) => ({ ...node, fingerprint: sha(serializeCampaignCreationNodeFingerprint(node)) }));
  const plan = CampaignCreationPlanV2.parse({ schemaVersion: 'openspell.campaign-creation-plan.v2',
    id: id(1), orgId: id(2), profileId: id(3), marketplaceId: 'ATVPDKIKX0DER', adProduct: 'SD', apiDialect: 'sd_legacy',
    providerScope: { amazonProfileId: '900000000001', connectionId: id(4), region: 'NA',
      marketplaceId: 'ATVPDKIKX0DER', currencyCode: 'USD', accountType: 'seller' },
    generatedAt: '2026-09-06T12:00:00.000Z', frozenAt: '2026-09-06T12:01:00.000Z',
    expiresAt: '2026-09-06T13:00:00.000Z', nodes, fingerprint: zero,
    counts: { totalNodes: 6, readChecks: 2, irreversibleCreates: 4,
      byKind: Object.fromEntries(CampaignCreationNodeKind.options.map((kind) => [kind, nodes.filter((node) => node.kind === kind).length])) },
    noRollbackAcknowledgement: { required: true, rollback: 'none', compensatingAction: 'separate_reviewed_pause_or_archive' },
  });
  plan.fingerprint = sha(serializeCampaignCreationPlanFingerprint(plan));
  return CampaignCreationApprovalSource.parse({ plan, profile: { id: plan.profileId, label: 'Synthetic profile' }, checkedAt: NOW,
    current: { orgId: plan.orgId, profileId: plan.profileId, planFingerprint: plan.fingerprint,
      providerScope: plan.providerScope,
      checks: plan.nodes.map((node) => ({ nodeId: node.nodeId, nodeFingerprint: node.fingerprint,
        result: 'passed', reason: null, checkedAt: '2026-09-06T12:04:00.000Z', validUntil: '2026-09-06T12:10:00.000Z' })),
      assets: [{ nodeId: id(11), moderation: 'unknown', observation: {
        scope: { region: 'NA', amazonProfileId: '900000000001' }, identity: { assetId: 'SYNTHETIC-VIDEO', version: '3' },
        observedAt: '2026-09-06T12:04:00.000Z', assetType: 'video', name: 'Synthetic video', processing: 'active',
        specChecks: { approvedPrograms: null, failedSpecChecks: null } } }] },
    admission: { kind: 'unavailable' } });
}

function admitted() {
  const value = source();
  const { plan } = value;
  const receipt = CampaignCreationAuthorizationReceipt.parse({ authorizationId: id(20), executionId: id(21), generation: id(22),
    schemaVersion: plan.schemaVersion, planId: plan.id, planFingerprint: plan.fingerprint, orgId: plan.orgId,
    profileId: plan.profileId, marketplaceId: plan.marketplaceId, adProduct: plan.adProduct, apiDialect: plan.apiDialect,
    expiresAt: plan.expiresAt, expectedCounts: plan.counts, noRollbackAcknowledgement: plan.noRollbackAcknowledgement,
    confirmationVersion: 'openspell.campaign-creation.no-delete-rollback.v1', approvedBy: id(23),
    approvedAt: '2026-09-06T12:03:00.000Z', gateSnapshotDigest: zero });
  const execution = CampaignCreationExecutionEvidence.parse({ plan, executionId: receipt.executionId,
    providerCallIntents: [], providerResults: [], observations: [],
    nonProviderDispositions: plan.nodes.filter((node) => node.effect === 'irreversible_create').map((node) => ({
      planId: plan.id, executionId: receipt.executionId, nodeId: node.nodeId, nodeFingerprint: node.fingerprint,
      outcome: 'pending_dispatch', sanitizedReason: null })),
    snapshot: { status: 'queued', accounting: { operatorApproved: 4, pendingDispatch: 4, attempted: 0,
      succeeded: 0, failed: 0, ambiguous: 0, refusedAtExecution: 0, blockedByDependency: 0,
      observed: 0, pendingObservation: 0, observationNotFound: 0, observationConflict: 0,
      readChecksRequested: 2, readChecksPending: 2, readChecksPassed: 0, readChecksRefused: 0, readChecksFailed: 0 } },
  });
  return { ...value, admission: { kind: 'recorded' as const, receipt, execution } };
}

describe('campaign creation recorded review contract', () => {
  it('keeps exact saved settings, separate counts and unknown admission/moderation', () => {
    const value = source();
    expect(value.plan.counts).toMatchObject({ totalNodes: 6, readChecks: 2, irreversibleCreates: 4 });
    expect(campaignCreationReviewFreshness(value)).toEqual({ status: 'current', reasons: [] });
    expect(value.admission.kind).toBe('unavailable');
    expect(value.current.assets[0]!.moderation).toBe('unknown');
    expect(value.plan.noRollbackAcknowledgement.rollback).toBe('none');
  });

  it.each(['org', 'profile', 'fingerprint', 'node', 'nodeFingerprint', 'duplicate', 'missing', 'future', 'assetScope', 'assetMissing', 'assetDuplicate'])(
    'refuses a mixed or incomplete snapshot: %s', (failure) => {
      const value = source();
      if (failure === 'org') value.current.orgId = id(900);
      if (failure === 'profile') value.profile.id = id(900);
      if (failure === 'fingerprint') value.current.planFingerprint = zero;
      if (failure === 'node') value.current.checks[0]!.nodeId = id(900);
      if (failure === 'nodeFingerprint') value.current.checks[0]!.nodeFingerprint = zero;
      if (failure === 'duplicate') value.current.checks[1] = value.current.checks[0]!;
      if (failure === 'missing') value.current.checks.pop();
      if (failure === 'future') value.current.checks[0]!.checkedAt = '2026-09-06T12:06:00.000Z';
      if (failure === 'assetScope') value.current.assets[0]!.observation!.scope.amazonProfileId = '900000000002';
      if (failure === 'assetMissing') value.current.assets = [];
      if (failure === 'assetDuplicate') value.current.assets.push(value.current.assets[0]!);
      expect(CampaignCreationApprovalSource.safeParse(value).success).toBe(false);
    },
  );

  it('cannot turn missing timestamps or a failed check into a green result', () => {
    const check = source().current.checks[0]!;
    expect(CampaignCreationReviewCheck.safeParse({ ...check, checkedAt: null, validUntil: null }).success).toBe(false);
    expect(CampaignCreationReviewCheck.safeParse({ ...check, result: 'passed', reason: 'ineligible' }).success).toBe(false);
    expect(CampaignCreationReviewCheck.safeParse({ ...check, result: 'unknown', reason: null }).success).toBe(false);
  });

  it('derives expiry and stale checks at the exact boundary without inventing a TTL', () => {
    const value = source();
    value.checkedAt = value.current.checks[0]!.validUntil!;
    expect(campaignCreationReviewFreshness(value)).toEqual({ status: 'stale', reasons: ['check_stale'] });
    value.checkedAt = value.plan.expiresAt;
    expect(campaignCreationReviewFreshness(value).reasons).toContain('plan_expired');
  });

  it('does not silently rebind a selected asset or infer eligibility/moderation from ACTIVE', () => {
    const value = source();
    value.current.assets[0]!.observation!.identity.version = '4';
    expect(campaignCreationReviewFreshness(value).reasons).toContain('asset_identity_mismatch');
    expect(value.plan.nodes.find((node) => node.kind === 'asset.require_existing')!.payload.version).toBe('3');
    value.current.assets[0]!.observation!.identity.version = '3';
    value.current.checks[0] = { ...value.current.checks[0]!, result: 'unknown', reason: 'unverified' };
    expect(campaignCreationReviewFreshness(value).reasons).toContain('check_unknown');
    expect(value.current.assets[0]!.moderation).toBe('unknown');
  });

  it.each(['image', 'unknown'] as const)('cannot accept %s metadata for a selected video', (assetType) => {
    const value = source();
    value.current.assets[0]!.observation!.assetType = assetType;
    expect(campaignCreationReviewFreshness(value).status).toBe('unavailable');
  });

  it('binds asset eligibility to the observed version event rather than a newly stamped check', () => {
    const value = source();
    value.current.assets[0]!.observation!.observedAt = '2000-01-01T00:00:00.000Z';
    expect(campaignCreationReviewFreshness(value).status).toBe('unavailable');
  });

  it('accepts equivalent timestamp spellings without losing sub-millisecond event differences', () => {
    const value = source();
    for (const observedAt of ['2026-09-06T12:04:00Z', '2026-09-06T12:04:00.000000Z']) {
      value.current.assets[0]!.observation!.observedAt = observedAt;
      expect(campaignCreationReviewFreshness(CampaignCreationApprovalSource.parse(value)).status).toBe('current');
    }
    value.current.assets[0]!.observation!.observedAt = '2026-09-06T12:04:00.000001Z';
    expect(campaignCreationReviewFreshness(CampaignCreationApprovalSource.parse(value)).status).toBe('unavailable');
  });

  it('does not expose a creative moderation decision from asset library metadata', () => {
    for (const moderation of ['approved', 'rejected', 'pending', 'not_applicable']) {
      const value = source();
      expect(CampaignCreationApprovalSource.safeParse({ ...value, current: { ...value.current,
        assets: [{ ...value.current.assets[0]!, moderation }] } }).success).toBe(false);
    }
  });

  it('keeps legacy plans readable without leaking asset observations whose frozen scope is unknown', () => {
    const value = source();
    const original = CampaignCreationPlanV2.parse(value.plan);
    const { providerScope: _scope, ...old } = original;
    const nodes = original.nodes.map((node) => {
      const { schemaVersion: _version, ...base } = node;
      if (node.kind === 'asset.require_existing') return CampaignCreationNodeV1.parse({ ...base,
        payload: { ...node.payload, purpose: 'display_creative' } });
      if (node.kind === 'campaign.create') return CampaignCreationNodeV1.parse({ ...base, payload: {
        name: node.payload.name, state: 'paused', budget: node.payload.budget, startDate: '2026-09-07', endDate: null,
        portfolioId: null, settings: { product: 'SD', tactic: 'contextual' } } });
      if (node.kind === 'ad_group.create') return CampaignCreationNodeV1.parse({ ...base, payload: {
        campaign: node.payload.campaign, name: node.payload.name, state: 'paused', defaultBid: 1 } });
      if (node.kind === 'creative.create') return CampaignCreationNodeV1.parse({ ...base, dependsOn: [id(11), id(14)],
        payload: { format: 'sd_custom', ad: ref('ad', 14), assets: [ref('asset', 11)], headline: null, state: 'paused' } });
      return CampaignCreationNodeV1.parse(base);
    }).map((node) => ({ ...node, fingerprint: sha(serializeCampaignCreationNodeFingerprint(node)) }));
    value.plan = CampaignCreationPlanV1.parse({ ...old, schemaVersion: 'openspell.campaign-creation-plan.v1', nodes });
    value.plan.fingerprint = sha(serializeCampaignCreationPlanFingerprint(value.plan));
    value.current.planFingerprint = value.plan.fingerprint;
    value.current.checks = value.plan.nodes.map((node) => ({ ...value.current.checks[0]!, nodeId: node.nodeId, nodeFingerprint: node.fingerprint }));
    expect(CampaignCreationApprovalSource.safeParse(value).success).toBe(false);
    value.current.assets[0]!.observation!.scope.amazonProfileId = '900000000002';
    expect(CampaignCreationApprovalSource.safeParse(value).success).toBe(false);
    value.current.assets[0]!.observation = null;
    expect(CampaignCreationApprovalSource.safeParse(value).success).toBe(true);
    expect(campaignCreationReviewFreshness(value).reasons).toContain('legacy_plan');
  });

  it.each(['plan', 'count', 'scope', 'early', 'future', 'execution'])(
    'refuses an admission joined to different evidence: %s', (failure) => {
      const value = admitted();
      if (failure === 'plan') value.admission.receipt.planFingerprint = zero;
      if (failure === 'count') value.admission.receipt.expectedCounts = { ...value.plan.counts, totalNodes: 7 };
      if (failure === 'scope') value.admission.receipt.orgId = id(900);
      if (failure === 'early') value.admission.receipt.approvedAt = value.plan.generatedAt;
      if (failure === 'future') value.admission.receipt.approvedAt = '2026-09-06T12:06:00.000Z';
      if (failure === 'execution') value.admission.receipt.executionId = id(900);
      expect(CampaignCreationApprovalSource.safeParse(value).success).toBe(false);
    },
  );

  it('preserves known approval after expiry and does not turn unavailable execution into queued', () => {
    const value = admitted();
    value.checkedAt = '2026-09-06T14:00:00.000Z';
    const parsed = CampaignCreationApprovalSource.parse({ ...value, admission: { ...value.admission, execution: null } });
    expect(parsed.admission).toMatchObject({ kind: 'recorded', execution: null });
    expect(campaignCreationReviewFreshness(parsed).reasons).toContain('plan_expired');
  });

  it('rejects forged display freshness and worker artifacts in the browser model', () => {
    const value = source();
    const view = { ...value, schemaVersion: 'openspell.campaign-creation-approval-view.v1',
      freshness: campaignCreationReviewFreshness(value), recordedContext: {
        guardrails: 'not_recorded', provenance: 'not_recorded', frozenProfileLabel: 'not_recorded' } };
    expect(CampaignCreationApprovalView.safeParse(view).success).toBe(true);
    expect(CampaignCreationApprovalView.safeParse({ ...view, admission: admitted().admission }).success).toBe(false);
    expect(CampaignCreationApprovalView.safeParse({ ...view, freshness: { status: 'stale', reasons: [] } }).success).toBe(false);
    expect(CampaignCreationApprovalView.safeParse({ ...view, canApprove: true }).success).toBe(false);
  });
});
