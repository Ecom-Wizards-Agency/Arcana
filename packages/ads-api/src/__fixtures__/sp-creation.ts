/** Synthetic plans and internally consistent evidence; no live authority or provider proof. */
import { createHash } from 'node:crypto';
import {
  CampaignCreationExecutionEvidence, CampaignCreationNodeKind, CampaignCreationNodeV2,
  CampaignCreationPlanV2, CampaignCreationProviderResult,
  deriveCampaignCreationExecutionStatus, orderCampaignCreationNodes,
  serializeCampaignCreationNodeFingerprint, serializeCampaignCreationPlanFingerprint,
  type CampaignCreationAccounting, type CampaignCreationPlan,
  type CampaignCreationSha256Hasher,
} from '@wizard-ads/shared';

export const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
export const PRODUCT = id(11);
export const CAMPAIGN = id(12);
export const GROUP = id(13);
export const AD = id(14);
export const TARGET = id(15);
export const AMAZON_CAMPAIGN = '90071992547409931111';
export const AMAZON_GROUP = '90071992547409932222';
export const zero = '0'.repeat(64);
export const hasher: CampaignCreationSha256Hasher = {
  algorithm: 'sha256', digest: (input) => createHash('sha256').update(input).digest('hex'),
};
export const ref = (kind: string, nodeId: string) => ({ source: 'plan_node', kind, nodeId });
export type TargetPayload = Extract<CampaignCreationNodeV2, { kind: 'target.create' }>['payload'];
type CampaignPayload = Extract<CampaignCreationNodeV2, { kind: 'campaign.create' }>['payload'];

export const keyword = { targetType: 'keyword', parent: { source: 'plan_node', kind: 'ad_group', nodeId: GROUP },
  scope: 'ad_group', polarity: 'positive', text: 'synthetic keyword', matchType: 'exact', bid: 1.25, state: 'paused' } satisfies TargetPayload;

export function fingerprint(plan: CampaignCreationPlanV2): CampaignCreationPlanV2 {
  const nodes = plan.nodes.map((node) => CampaignCreationNodeV2.parse({ ...node,
    fingerprint: hasher.digest(serializeCampaignCreationNodeFingerprint(node)) }));
  const withNodes = CampaignCreationPlanV2.parse({ ...plan, nodes, fingerprint: zero });
  return CampaignCreationPlanV2.parse({ ...withNodes,
    fingerprint: hasher.digest(serializeCampaignCreationPlanFingerprint(withNodes)) });
}

export function plan(options: { target?: TargetPayload | null; automatic?: boolean;
  accountType?: 'seller' | 'vendor' | 'agency'; sku?: string | null;
  campaign?: Partial<CampaignPayload> } = {}): CampaignCreationPlanV2 {
  const common = { schemaVersion: 'openspell.campaign-creation-node.v2', adProduct: 'SP',
    apiDialect: 'sp_legacy_v3', fingerprint: zero };
  const create = { ...common, effect: 'irreversible_create', rollback: 'none' };
  const target = options.target === undefined ? keyword : options.target;
  const rawNodes = [{ ...common, nodeId: PRODUCT, kind: 'eligibility.require_product', dependsOn: [],
    effect: 'read_check', rollback: 'not_applicable',
    payload: { asin: 'B000000001', sku: options.sku === undefined ? 'SYNTHETIC-SKU' : options.sku } },
  { ...create, nodeId: CAMPAIGN, kind: 'campaign.create', dependsOn: [PRODUCT], payload: {
    name: 'Synthetic campaign', state: 'paused', budget: { amount: 20, type: 'daily', currencyCode: 'USD' },
    schedule: { type: 'calendar_dates', startDate: '2026-09-07', endDate: null }, portfolioId: null,
    settings: { product: 'SP', targetingType: options.automatic === true ? 'auto' : 'manual',
      biddingStrategy: 'manual', placementBidding: { topOfSearch: 25, productPages: 0, restOfSearch: 10 } },
    ...options.campaign,
  } },
  { ...create, nodeId: GROUP, kind: 'ad_group.create', dependsOn: [CAMPAIGN], payload: {
    campaign: ref('campaign', CAMPAIGN), name: 'Synthetic ad group', state: 'paused', defaultBid: 1.1,
    settings: { product: 'SP' },
  } },
  { ...create, nodeId: AD, kind: 'ad.create', dependsOn: [PRODUCT, GROUP], payload: {
    format: 'sp_product_ad', adGroup: ref('ad_group', GROUP), product: ref('product', PRODUCT), state: 'paused',
  } },
  ...(target === null ? [] : [{ ...create, nodeId: TARGET, kind: 'target.create',
    dependsOn: [target.parent.nodeId], payload: target }])];
  const nodes = orderCampaignCreationNodes(rawNodes.map((node) => CampaignCreationNodeV2.parse(node)));
  const readChecks = nodes.filter((node) => node.effect === 'read_check').length;
  return fingerprint(CampaignCreationPlanV2.parse({ schemaVersion: 'openspell.campaign-creation-plan.v2',
    id: id(1), orgId: id(2), profileId: id(3), marketplaceId: 'ATVPDKIKX0DER',
    adProduct: 'SP', apiDialect: 'sp_legacy_v3',
    providerScope: { amazonProfileId: '900000000001', connectionId: id(4), region: 'NA',
      marketplaceId: 'ATVPDKIKX0DER', currencyCode: 'USD', accountType: options.accountType ?? 'seller' },
    generatedAt: '2026-09-06T12:00:00.000Z', frozenAt: '2026-09-06T12:01:00.000Z',
    expiresAt: '2026-09-06T13:00:00.000Z', nodes, fingerprint: zero,
    counts: { totalNodes: nodes.length, readChecks, irreversibleCreates: nodes.length - readChecks,
      byKind: Object.fromEntries(CampaignCreationNodeKind.options.map((kind) =>
        [kind, nodes.filter((node) => node.kind === kind).length])) },
    noRollbackAcknowledgement: { required: true, rollback: 'none',
      compensatingAction: 'separate_reviewed_pause_or_archive' },
  }));
}

export function evidence(plan: CampaignCreationPlan, beforeNode: string): CampaignCreationExecutionEvidence {
  const beforeIndex = plan.nodes.findIndex((node) => node.nodeId === beforeNode);
  const completed = plan.nodes.slice(0, beforeIndex);
  const providerResults = completed.map((node, index) => CampaignCreationProviderResult.parse({
    effect: node.effect, planId: plan.id, nodeId: node.nodeId, executionId: id(5),
    attemptId: id(index + 100), providerCallId: id(index + 200), nodeFingerprint: node.fingerprint,
    requestIndex: node.effect === 'read_check' ? null : 0,
    ...(node.effect === 'irreversible_create' ? { requestDigest: zero, nodeRequestDigest: zero } : {}),
    outcome: node.effect === 'read_check' ? 'passed' : 'succeeded',
    providerEntityId: node.kind === 'eligibility.require_product' ? node.payload.asin
      : node.nodeId === CAMPAIGN ? AMAZON_CAMPAIGN : node.nodeId === GROUP ? AMAZON_GROUP : '90071992547409933333',
    providerEntityVersion: null, providerCode: null, sanitizedMessage: null,
    providerRequestId: 'synthetic-request', responseDigest: zero,
    startedAt: `2026-09-06T12:02:${String(index * 4 + 1).padStart(2, '0')}.000Z`,
    completedAt: `2026-09-06T12:02:${String(index * 4 + 2).padStart(2, '0')}.000Z`,
  }));
  const providerCallIntents = providerResults.flatMap((result, index) => result.effect === 'read_check' ? [] : [{
    planId: plan.id, planFingerprint: plan.fingerprint, executionId: id(5), authorizationId: id(6), generation: id(7),
    attemptId: result.attemptId, providerCallId: result.providerCallId, requestDigest: zero,
    positions: [{ requestIndex: 0, nodeId: result.nodeId, nodeFingerprint: result.nodeFingerprint, requestDigest: zero }],
    recordedAt: `2026-09-06T12:02:${String(index * 4).padStart(2, '0')}.000Z`,
  }]);
  const observations = providerResults.flatMap((result, index) => result.effect === 'read_check' ? [] : [{
    planId: plan.id, nodeId: result.nodeId, executionId: id(5), authorizationId: id(6), generation: id(7),
    attemptId: result.attemptId, providerCallId: result.providerCallId,
    nodeFingerprint: result.nodeFingerprint, requestDigest: zero, nodeRequestDigest: zero,
    basis: 'provider_result_identity', providerEntityId: result.providerEntityId, observation: 'observed',
    amazonModerationStatus: 'not_applicable', deliveryStatus: 'not_delivering',
    observedAt: `2026-09-06T12:02:${String(index * 4 + 3).padStart(2, '0')}.000Z`, sourceSyncJobId: id(8),
  }]);
  const nonProviderDispositions = plan.nodes.slice(beforeIndex).filter((node) => node.effect === 'irreversible_create')
    .map((node) => ({ planId: plan.id, nodeId: node.nodeId, executionId: id(5), nodeFingerprint: node.fingerprint,
      outcome: 'pending_dispatch', sanitizedReason: null }));
  const readPassed = providerResults.filter((result) => result.effect === 'read_check').length;
  const created = providerCallIntents.length;
  const accounting: CampaignCreationAccounting = {
    operatorApproved: plan.counts.irreversibleCreates, pendingDispatch: nonProviderDispositions.length,
    attempted: created, succeeded: created, failed: 0, ambiguous: 0, refusedAtExecution: 0, blockedByDependency: 0,
    observed: created, pendingObservation: 0, observationNotFound: 0, observationConflict: 0,
    readChecksRequested: plan.counts.readChecks, readChecksPending: plan.counts.readChecks - readPassed,
    readChecksPassed: readPassed, readChecksRefused: 0, readChecksFailed: 0,
  };
  return CampaignCreationExecutionEvidence.parse({ plan, executionId: id(5), providerCallIntents, providerResults,
    observations, nonProviderDispositions, snapshot: { status: deriveCampaignCreationExecutionStatus(accounting), accounting } });
}
