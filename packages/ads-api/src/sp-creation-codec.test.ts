import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CampaignCreationExecutionEvidence, CampaignCreationNodeKind, CampaignCreationNodeV2,
  CampaignCreationPlanV1, CampaignCreationPlanV2, CampaignCreationProviderResult,
  deriveCampaignCreationExecutionStatus, orderCampaignCreationNodes,
  serializeCampaignCreationNodeFingerprint, serializeCampaignCreationPlanFingerprint,
  type CampaignCreationAccounting, type CampaignCreationPlan,
  type CampaignCreationSha256Hasher,
} from '@wizard-ads/shared';
import { prepareSpCreationCall } from './sp-creation-codec.js';

const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const PRODUCT = id(11);
const CAMPAIGN = id(12);
const GROUP = id(13);
const AD = id(14);
const TARGET = id(15);
const AMAZON_CAMPAIGN = '90071992547409931111';
const AMAZON_GROUP = '90071992547409932222';
const zero = '0'.repeat(64);
const hasher: CampaignCreationSha256Hasher = {
  algorithm: 'sha256', digest: (input) => createHash('sha256').update(input).digest('hex'),
};
const ref = (kind: string, nodeId: string) => ({ source: 'plan_node', kind, nodeId });
type TargetPayload = Extract<CampaignCreationNodeV2, { kind: 'target.create' }>['payload'];
type CampaignPayload = Extract<CampaignCreationNodeV2, { kind: 'campaign.create' }>['payload'];

const keyword: TargetPayload = { targetType: 'keyword', parent: { source: 'plan_node', kind: 'ad_group', nodeId: GROUP },
  scope: 'ad_group', polarity: 'positive', text: 'synthetic keyword', matchType: 'exact', bid: 1.25, state: 'paused' };

function fingerprint(plan: CampaignCreationPlanV2): CampaignCreationPlanV2 {
  const nodes = plan.nodes.map((node) => CampaignCreationNodeV2.parse({ ...node,
    fingerprint: hasher.digest(serializeCampaignCreationNodeFingerprint(node)) }));
  const withNodes = CampaignCreationPlanV2.parse({ ...plan, nodes, fingerprint: zero });
  return CampaignCreationPlanV2.parse({ ...withNodes,
    fingerprint: hasher.digest(serializeCampaignCreationPlanFingerprint(withNodes)) });
}

function plan(options: { target?: TargetPayload | null; automatic?: boolean;
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

function evidence(plan: CampaignCreationPlan, beforeNode: string): CampaignCreationExecutionEvidence {
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

function compile(plan: CampaignCreationPlanV2, nodeId: string) {
  return prepareSpCreationCall({ plan, nodeId, currentEvidence: evidence(plan, nodeId) }, hasher);
}

describe('SP creation codec', () => {
  it('compiles one paused campaign with exact calendar dates and all three placement modifiers', () => {
    const fixture = plan();
    const currentEvidence = evidence(fixture, CAMPAIGN);
    const before = JSON.stringify({ fixture, currentEvidence });
    const call = prepareSpCreationCall({ plan: fixture, nodeId: CAMPAIGN, currentEvidence }, hasher);
    expect(call).toMatchObject({ kind: 'campaigns', method: 'POST', path: '/sp/campaigns',
      mediaType: 'application/vnd.spCampaign.v3+json', providerScope: fixture.providerScope });
    expect(JSON.parse(call.body)).toEqual({ campaigns: [{ name: 'Synthetic campaign', state: 'PAUSED',
      targetingType: 'MANUAL', startDate: '2026-09-07', budget: { budget: 20, budgetType: 'DAILY' },
      dynamicBidding: { strategy: 'MANUAL', placementBidding: [
        { placement: 'PLACEMENT_TOP', percentage: 25 }, { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: 0 },
        { placement: 'PLACEMENT_REST_OF_SEARCH', percentage: 10 },
      ] } }] });
    expect(call.positions).toHaveLength(1);
    expect(call.positions[0]).toMatchObject({ requestIndex: 0, nodeId: CAMPAIGN,
      nodeFingerprint: fixture.nodes.find((node) => node.nodeId === CAMPAIGN)!.fingerprint });
    expect(call.requestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(call.positions[0]!.requestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify({ fixture, currentEvidence })).toBe(before);
    expect(prepareSpCreationCall({ plan: fixture, nodeId: CAMPAIGN, currentEvidence }, hasher)).toEqual(call);
    expect(Object.isFrozen(call)).toBe(true);
    expect(Object.isFrozen(call.positions)).toBe(true);
  });

  it('preserves an explicit end date and maps dynamic bidding', () => {
    const fixture = plan({ campaign: {
      schedule: { type: 'calendar_dates', startDate: '2026-09-07', endDate: '2026-10-07' },
      settings: { product: 'SP', targetingType: 'manual', biddingStrategy: 'auto_for_sales',
        placementBidding: { topOfSearch: 0, productPages: 0, restOfSearch: 0 } } } });
    expect(JSON.parse(compile(fixture, CAMPAIGN).body)).toMatchObject({ campaigns: [{
      endDate: '2026-10-07',
      dynamicBidding: { strategy: 'AUTO_FOR_SALES' },
    }] });
  });

  it('refuses an existing portfolio without a scoped portfolio preflight', () => {
    expect(() => compile(plan({ campaign: { portfolioId: 'synthetic-portfolio' } }), CAMPAIGN)).toThrow();
  });

  it('creates an automatic campaign without inventing create-target clauses', () => {
    const fixture = plan({ automatic: true, target: null });
    expect(JSON.parse(compile(fixture, CAMPAIGN).body).campaigns[0].targetingType).toBe('AUTO');
    expect(fixture.counts.byKind['target.create']).toBe(0);
    expect(() => compile(fixture, TARGET)).toThrow();
  });

  it('resolves an observed campaign parent without rounding its Amazon ID', () => {
    expect(JSON.parse(compile(plan(), GROUP).body)).toEqual({ adGroups: [{ campaignId: AMAZON_CAMPAIGN,
      name: 'Synthetic ad group', state: 'PAUSED', defaultBid: 1.1 }] });
  });

  it('refuses a missing ad-group default bid instead of inventing one', () => {
    const fixture = plan();
    const group = fixture.nodes.find((node) => node.kind === 'ad_group.create')!;
    group.payload.defaultBid = null;
    expect(() => compile(fingerprint(fixture), GROUP)).toThrow();
  });

  it.each(['seller', 'vendor'] as const)('selects only the checked %s product identity', (accountType) => {
    const call = compile(plan({ accountType }), AD);
    expect(call.kind).toBe('productAds');
    expect(JSON.parse(call.body)).toEqual({ productAds: [{ campaignId: AMAZON_CAMPAIGN,
      adGroupId: AMAZON_GROUP, state: 'PAUSED',
      ...(accountType === 'seller' ? { sku: 'SYNTHETIC-SKU' } : { asin: 'B000000001' }) }] });
  });

  it.each(['exact', 'phrase', 'broad'] as const)('compiles a positive %s keyword and its exact bid', (matchType) => {
    const call = compile(plan({ target: { ...keyword, matchType } }), TARGET);
    expect(call).toMatchObject({ kind: 'keywords', path: '/sp/keywords', mediaType: 'application/vnd.spKeyword.v3+json' });
    expect(JSON.parse(call.body)).toEqual({ keywords: [{ campaignId: AMAZON_CAMPAIGN, adGroupId: AMAZON_GROUP,
      keywordText: 'synthetic keyword', matchType: matchType.toUpperCase(), bid: 1.25, state: 'PAUSED' }] });
  });

  it('omits optional null keyword bid', () => {
    expect(JSON.parse(compile(plan({ target: { ...keyword, bid: null } }), TARGET).body).keywords[0])
      .not.toHaveProperty('bid');
  });

  it('compiles a positive product target using manual expression predicates', () => {
    const call = compile(plan({ target: { targetType: 'expression', parent: keyword.parent, scope: 'ad_group',
      polarity: 'positive', bid: 1.5, state: 'paused', expression: [{ type: 'asin_same_as', value: 'B000000002' }] } }), TARGET);
    expect(call).toMatchObject({ kind: 'targets', path: '/sp/targets', mediaType: 'application/vnd.spTargetingClause.v3+json' });
    expect(JSON.parse(call.body)).toEqual({ targetingClauses: [{ campaignId: AMAZON_CAMPAIGN, adGroupId: AMAZON_GROUP,
      state: 'PAUSED', bid: 1.5, expressionType: 'MANUAL', expression: [{ type: 'ASIN_SAME_AS', value: 'B000000002' }] }] });
  });

  it.each(['campaign', 'ad_group'] as const)('compiles a %s negative keyword without a bid', (scope) => {
    const target: TargetPayload = { ...keyword, polarity: 'negative', matchType: 'negative_phrase', bid: null,
      scope, parent: { source: 'plan_node', kind: scope, nodeId: scope === 'campaign' ? CAMPAIGN : GROUP } };
    const call = compile(plan({ target }), TARGET);
    const noun = scope === 'campaign' ? 'campaignNegativeKeywords' : 'negativeKeywords';
    expect(call.kind).toBe(noun);
    expect(call.path).toBe(`/sp/${noun}`);
    expect(JSON.parse(call.body)).toEqual({ [noun]: [{ campaignId: AMAZON_CAMPAIGN,
      ...(scope === 'campaign' ? {} : { adGroupId: AMAZON_GROUP }), keywordText: 'synthetic keyword',
      matchType: 'NEGATIVE_PHRASE', state: 'PAUSED' }] });
  });

  it.each(['campaign', 'ad_group'] as const)('compiles a %s negative product target in its own envelope', (scope) => {
    const target: TargetPayload = { targetType: 'expression', polarity: 'negative', bid: null, scope, state: 'paused',
      parent: { source: 'plan_node', kind: scope, nodeId: scope === 'campaign' ? CAMPAIGN : GROUP },
      expression: [{ type: 'asin_brand_same_as', value: 'synthetic-brand' }] };
    const call = compile(plan({ target, automatic: scope === 'campaign' }), TARGET);
    expect(call.kind).toBe(scope === 'campaign' ? 'campaignNegativeTargets' : 'negativeTargets');
    const noun = scope === 'campaign' ? 'campaignNegativeTargetingClauses' : 'negativeTargetingClauses';
    expect(JSON.parse(call.body)).toEqual({ [noun]: [{ campaignId: AMAZON_CAMPAIGN,
      ...(scope === 'campaign' ? {} : { adGroupId: AMAZON_GROUP }), state: 'PAUSED',
      expression: [{ type: 'ASIN_BRAND_SAME_AS', value: 'synthetic-brand' }] }] });
  });

  it('refuses unsupported bidding, agency accounts and missing seller SKU before preparation', () => {
    const ruleBased = plan({ campaign: { settings: { product: 'SP', targetingType: 'manual',
      biddingStrategy: 'rule_based', placementBidding: { topOfSearch: 0, productPages: 0, restOfSearch: 0 } } } });
    expect(() => compile(ruleBased, CAMPAIGN)).toThrow();
    expect(() => compile(plan({ accountType: 'agency' }), AD)).toThrow();
    expect(() => compile(plan({ sku: null }), AD)).toThrow();
  });

  it.each(['asin_expanded_from', 'asin_category_same_as'] as const)('refuses unsupported negative predicate %s', (type) => {
    const fixture = plan({ target: { targetType: 'expression', parent: keyword.parent, scope: 'ad_group',
      polarity: 'negative', bid: null, state: 'paused', expression: [{ type, value: 'synthetic-value' }] } });
    expect(() => compile(fixture, TARGET)).toThrow();
  });

  it('refuses campaign negative product targets in a manual campaign', () => {
    const fixture = plan({ target: { targetType: 'expression', parent: { source: 'plan_node', kind: 'campaign', nodeId: CAMPAIGN },
      scope: 'campaign', polarity: 'negative', bid: null, state: 'paused', expression: [{ type: 'asin_same_as', value: 'B000000002' }] } });
    expect(() => compile(fixture, TARGET)).toThrow();
  });

  it('refuses more than 1000 expression predicates instead of splitting one node silently', () => {
    const fixture = plan({ target: { targetType: 'expression', parent: keyword.parent, scope: 'ad_group',
      polarity: 'positive', bid: null, state: 'paused', expression: Array.from({ length: 1001 }, (_, index) =>
        ({ type: 'asin_same_as', value: `synthetic-${index}` })) } });
    expect(() => compile(fixture, TARGET)).toThrow();
  });

  it('retains all 1000 allowed predicates in exactly one resource and request position', () => {
    const fixture = plan({ target: { targetType: 'expression', parent: keyword.parent, scope: 'ad_group',
      polarity: 'positive', bid: null, state: 'paused', expression: Array.from({ length: 1000 }, (_, index) =>
        ({ type: 'asin_same_as', value: `synthetic-${index}` })) } });
    const call = compile(fixture, TARGET);
    const body = JSON.parse(call.body) as { targetingClauses: { expression: unknown[] }[] };
    expect(body.targetingClauses).toHaveLength(1);
    expect(body.targetingClauses[0]!.expression).toHaveLength(1000);
    expect(body.targetingClauses[0]!.expression[999]).toEqual({ type: 'ASIN_SAME_AS', value: 'synthetic-999' });
    expect(call.positions).toHaveLength(1);
  });

  it.each([0, 0.001, 1.001, 1000.01])('refuses the unsupported USD bid %s without rounding or clamping', (bid) => {
    expect(() => compile(plan({ target: { ...keyword, bid } }), TARGET)).toThrow();
  });

  it.each([0.99, 20.001, 1000000.01])('refuses the unsupported USD daily budget %s', (amount) => {
    expect(() => compile(plan({ campaign: { budget: { amount, type: 'daily', currencyCode: 'USD' } } }), CAMPAIGN)).toThrow();
  });

  it('checks region and currency against the marketplace even for freshly fingerprinted plans', () => {
    const fixture = plan();
    const wrongRegion = fingerprint({ ...fixture, providerScope: { ...fixture.providerScope, region: 'EU' } });
    expect(() => compile(wrongRegion, CAMPAIGN)).toThrow();
    const wrongCurrency = structuredClone(fixture);
    wrongCurrency.providerScope.currencyCode = 'EUR';
    wrongCurrency.nodes.forEach((node) => {
      if (node.kind === 'campaign.create') node.payload.budget.currencyCode = 'EUR';
    });
    expect(() => compile(fingerprint(wrongCurrency), CAMPAIGN)).toThrow();
    const unavailable = fingerprint({ ...fixture, marketplaceId: 'unverified-marketplace',
      providerScope: { ...fixture.providerScope, marketplaceId: 'unverified-marketplace' } });
    expect(() => compile(unavailable, CAMPAIGN)).toThrow();
  });

  it('binds the request digests to the exact resource, frozen body and profile scope', () => {
    const fixture = plan();
    const first = compile(fixture, CAMPAIGN);
    const otherScope = fingerprint({ ...fixture, providerScope: { ...fixture.providerScope, amazonProfileId: '900000000002' } });
    const otherBudget = plan({ campaign: { budget: { amount: 21, type: 'daily', currencyCode: 'USD' } } });
    for (const changed of [compile(otherScope, CAMPAIGN), compile(otherBudget, CAMPAIGN), compile(fixture, GROUP)]) {
      expect(changed.requestDigest).not.toBe(first.requestDigest);
      expect(changed.positions[0]!.requestDigest).not.toBe(first.positions[0]!.requestDigest);
    }
  });

  it('rejects a changed payload even when its old fingerprint and evidence are retained', () => {
    const fixture = plan();
    const currentEvidence = evidence(fixture, CAMPAIGN);
    const tampered = structuredClone(fixture);
    const campaign = tampered.nodes.find((node) => node.kind === 'campaign.create')!;
    campaign.payload.name = 'Changed after approval';
    expect(() => prepareSpCreationCall({ plan: tampered, currentEvidence, nodeId: CAMPAIGN }, hasher)).toThrow();
  });

  it('rejects independently valid evidence for a different frozen provider scope', () => {
    const fixture = plan();
    const other = fingerprint({ ...fixture, providerScope: { ...fixture.providerScope, amazonProfileId: '900000000002' } });
    expect(() => prepareSpCreationCall({ plan: fixture, currentEvidence: evidence(other, CAMPAIGN), nodeId: CAMPAIGN }, hasher)).toThrow();
  });

  it('rejects another execution identity in otherwise unchanged evidence', () => {
    const fixture = plan();
    const currentEvidence = evidence(fixture, GROUP);
    currentEvidence.executionId = id(999);
    expect(() => prepareSpCreationCall({ plan: fixture, currentEvidence, nodeId: GROUP }, hasher)).toThrow();
  });

  it('requires a passed read dependency before campaign creation', () => {
    const fixture = plan();
    const currentEvidence = evidence(fixture, PRODUCT);
    expect(() => prepareSpCreationCall({ plan: fixture, currentEvidence, nodeId: CAMPAIGN }, hasher)).toThrow();
    expect(() => prepareSpCreationCall({ plan: fixture, currentEvidence, nodeId: PRODUCT }, hasher)).toThrow();
  });

  it('refuses a child after an authoritatively rejected parent with coherent blocked accounting', () => {
    const fixture = plan();
    const currentEvidence = evidence(fixture, GROUP);
    const campaignResult = currentEvidence.providerResults.find((result) => result.nodeId === CAMPAIGN)!;
    if (campaignResult.effect !== 'irreversible_create') throw new Error('expected synthetic create result');
    campaignResult.outcome = 'authoritative_rejected';
    campaignResult.providerEntityId = null;
    campaignResult.providerCode = 'SYNTHETIC_REFUSAL';
    currentEvidence.observations = [];
    currentEvidence.nonProviderDispositions.forEach((item) => {
      item.outcome = 'blocked_by_dependency'; item.sanitizedReason = 'Parent creation refused';
    });
    Object.assign(currentEvidence.snapshot.accounting, { pendingDispatch: 0, succeeded: 0, failed: 1,
      observed: 0, blockedByDependency: 3 });
    currentEvidence.snapshot.status = deriveCampaignCreationExecutionStatus(currentEvidence.snapshot.accounting);
    expect(CampaignCreationExecutionEvidence.safeParse(currentEvidence).success).toBe(true);
    expect(() => prepareSpCreationCall({ plan: fixture, currentEvidence, nodeId: GROUP }, hasher)).toThrow();
  });

  it('requires exact observation after parent acceptance before creating a child', () => {
    const fixture = plan();
    const currentEvidence = evidence(fixture, GROUP);
    currentEvidence.observations[0]!.observation = 'pending';
    currentEvidence.snapshot.accounting.observed = 0;
    currentEvidence.snapshot.accounting.pendingObservation = 1;
    expect(CampaignCreationExecutionEvidence.safeParse(currentEvidence).success).toBe(true);
    expect(() => prepareSpCreationCall({ plan: fixture, currentEvidence, nodeId: GROUP }, hasher)).toThrow();
    currentEvidence.observations[0]!.observation = 'observed';
    currentEvidence.observations[0]!.providerEntityId = 'other-campaign';
    currentEvidence.snapshot.accounting.observed = 1;
    currentEvidence.snapshot.accounting.pendingObservation = 0;
    expect(() => prepareSpCreationCall({ plan: fixture, currentEvidence, nodeId: GROUP }, hasher)).toThrow();
  });

  it('cannot prepare a second create for a successful or unresolved prior intent', () => {
    const fixture = plan();
    const currentEvidence = evidence(fixture, GROUP);
    expect(() => prepareSpCreationCall({ plan: fixture, currentEvidence, nodeId: CAMPAIGN }, hasher)).toThrow();
    currentEvidence.providerResults = currentEvidence.providerResults.filter((result) => result.nodeId !== CAMPAIGN);
    currentEvidence.observations = [];
    Object.assign(currentEvidence.snapshot.accounting, { succeeded: 0, ambiguous: 1, observed: 0, pendingObservation: 1 });
    expect(CampaignCreationExecutionEvidence.safeParse(currentEvidence).success).toBe(true);
    expect(() => prepareSpCreationCall({ plan: fixture, currentEvidence, nodeId: CAMPAIGN }, hasher)).toThrow();
  });

  it('refuses v1 artifacts that cannot bind the provider scope', () => {
    const fixture = plan();
    const { providerScope: _scope, ...base } = fixture;
    const nodes = fixture.nodes.map((node) => {
      const { schemaVersion: _version, ...oldNode } = node;
      if (node.kind === 'campaign.create') {
        const { schedule, ...payload } = node.payload;
        if (schedule.type !== 'calendar_dates') throw new Error('expected synthetic SP dates');
        return { ...oldNode, payload: { ...payload, startDate: schedule.startDate, endDate: schedule.endDate } };
      }
      if (node.kind === 'ad_group.create') {
        const { settings: _settings, ...payload } = node.payload;
        return { ...oldNode, payload };
      }
      return oldNode;
    });
    const older = CampaignCreationPlanV1.parse({ ...base, schemaVersion: 'openspell.campaign-creation-plan.v1', nodes });
    older.nodes.forEach((node) => { node.fingerprint = hasher.digest(serializeCampaignCreationNodeFingerprint(node)); });
    older.fingerprint = hasher.digest(serializeCampaignCreationPlanFingerprint(older));
    expect(() => prepareSpCreationCall({ plan: older,
      currentEvidence: evidence(older, CAMPAIGN), nodeId: CAMPAIGN }, hasher)).toThrow();
  });
});
