import { describe, expect, it, vi } from 'vitest';
import { CampaignCreationAuthorizationReceipt, CampaignCreationExecutionEvidence,
  CampaignCreationProviderCallIntent, CampaignCreationProviderResult, CampaignCreationObserveJob,
  deriveCampaignCreationExecutionStatus, type CampaignCreationPlanV2 } from '@wizard-ads/shared';
import { createSpCreationAdapter, type SpCreationAdapter } from './sp-creation-adapter.js';
import { prepareSpCreationCall, prepareSpCreationReadback } from './sp-creation-codec.js';
import { decodeSpCreationReadback } from './sp-creation-readback.js';
import { plan, evidence, hasher, id, zero, CAMPAIGN, GROUP, AD, TARGET,
  AMAZON_CAMPAIGN, AMAZON_GROUP, keyword, type TargetPayload } from './__fixtures__/sp-creation.js';
import type { FetchLike } from './types.js';

const CREATED_ID = '900719925474099398765';
const NOW = Date.parse('2026-09-06T12:04:00.000Z');
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const parents = { campaignId: AMAZON_CAMPAIGN, adGroupId: AMAZON_GROUP };
const campaignRow = () => ({ campaignId: CREATED_ID, name: 'Synthetic campaign', state: 'PAUSED',
  targetingType: 'MANUAL', budget: { budget: 20, budgetType: 'DAILY' }, startDate: '2026-09-07',
  dynamicBidding: { strategy: 'MANUAL', placementBidding: [
    { placement: 'PLACEMENT_TOP', percentage: 25 }, { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: 0 },
    { placement: 'PLACEMENT_REST_OF_SEARCH', percentage: 10 },
  ] } });

function created(fixture = plan(), nodeId = CAMPAIGN): Parameters<SpCreationAdapter['observeNode']>[0] {
  const before = evidence(fixture, nodeId);
  const call = prepareSpCreationCall({ plan: fixture, currentEvidence: before, nodeId }, hasher);
  const intent = CampaignCreationProviderCallIntent.parse({ planId: fixture.id, planFingerprint: fixture.fingerprint,
    executionId: id(5), authorizationId: id(6), generation: id(7), attemptId: id(500), providerCallId: id(501),
    requestDigest: call.requestDigest, positions: call.positions, recordedAt: '2026-09-06T12:02:59.000Z' });
  const position = call.positions[0];
  const result = CampaignCreationProviderResult.parse({ effect: 'irreversible_create', planId: fixture.id,
    nodeId, executionId: id(5), attemptId: intent.attemptId, providerCallId: intent.providerCallId,
    nodeFingerprint: position.nodeFingerprint, requestIndex: 0, requestDigest: call.requestDigest,
    nodeRequestDigest: position.requestDigest, outcome: 'succeeded', providerEntityId: CREATED_ID,
    providerEntityVersion: null, providerCode: null, sanitizedMessage: null, providerRequestId: null,
    responseDigest: zero, startedAt: '2026-09-06T12:03:00.000Z', completedAt: '2026-09-06T12:03:01.000Z' });
  const accounting = { ...before.snapshot.accounting,
    pendingDispatch: before.snapshot.accounting.pendingDispatch - 1,
    attempted: before.snapshot.accounting.attempted + 1, succeeded: before.snapshot.accounting.succeeded + 1,
    pendingObservation: 1 };
  const currentEvidence = CampaignCreationExecutionEvidence.parse({ ...before,
    providerCallIntents: [...before.providerCallIntents, intent], providerResults: [...before.providerResults, result],
    nonProviderDispositions: before.nonProviderDispositions.filter((value) => value.nodeId !== nodeId),
    snapshot: { status: deriveCampaignCreationExecutionStatus(accounting), accounting } });
  return { plan: fixture, currentEvidence, nodeId, sourceSyncJobId: id(502),
    authorization: CampaignCreationAuthorizationReceipt.parse({ authorizationId: id(6), executionId: id(5), generation: id(7),
      schemaVersion: fixture.schemaVersion, planId: fixture.id, planFingerprint: fixture.fingerprint,
      orgId: fixture.orgId, profileId: fixture.profileId, marketplaceId: fixture.marketplaceId,
      adProduct: fixture.adProduct, apiDialect: fixture.apiDialect, expiresAt: fixture.expiresAt,
      expectedCounts: fixture.counts, noRollbackAcknowledgement: fixture.noRollbackAcknowledgement,
      confirmationVersion: 'openspell.campaign-creation.no-delete-rollback.v1',
      approvedBy: id(9), approvedAt: '2026-09-06T12:01:15.000Z', gateSnapshotDigest: zero }),
    job: CampaignCreationObserveJob.parse({ type: 'campaign_creation.observe', orgId: fixture.orgId,
      profileId: fixture.profileId, planId: fixture.id, planFingerprint: fixture.fingerprint,
      executionId: id(5), authorizationId: id(6), generation: id(7), attempt: 1 }),
  };
}

function adapter(input = created(), provider: FetchLike = async () => new Response(JSON.stringify({ campaigns: [campaignRow()] })),
  clock: () => number = () => NOW) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const token = vi.fn(async () => new Response(JSON.stringify({ access_token: ['synthetic', 'access'].join('-'), expires_in: 3600 })));
  const client = createSpCreationAdapter({ region: 'NA', now: clock, retry: { maxAttempts: 5 },
    credentials: { clientId: 'synthetic-client', clientSecret: ['synthetic', 'secret'].join('-'), refreshToken: ['synthetic', 'refresh'].join('-') },
    sleep: async () => undefined, fetch: async (url, init) => {
      if (url === 'https://api.amazon.com/auth/o2/token') return token();
      calls.push({ url, ...(init === undefined ? {} : { init }) });
      return provider(url, init);
    },
  }, { hasher, providerScope: (input.plan as CampaignCreationPlanV2).providerScope });
  return { client, calls, token };
}

const cases: { route: string; envelope: string; filter: string; input: () => ReturnType<typeof created>; row: () => Record<string, unknown> }[] = [
  { route: 'campaigns', envelope: 'campaigns', filter: 'campaignIdFilter', input: () => created(), row: campaignRow },
  { route: 'adGroups', envelope: 'adGroups', filter: 'adGroupIdFilter', input: () => created(plan(), GROUP),
    row: () => ({ adGroupId: CREATED_ID, campaignId: AMAZON_CAMPAIGN, name: 'Synthetic ad group', state: 'PAUSED', defaultBid: 1.1 }) },
  { route: 'productAds', envelope: 'productAds', filter: 'adIdFilter', input: () => created(plan(), AD),
    row: () => ({ adId: CREATED_ID, ...parents, state: 'PAUSED', sku: 'SYNTHETIC-SKU' }) },
  { route: 'keywords', envelope: 'keywords', filter: 'keywordIdFilter', input: () => created(plan(), TARGET),
    row: () => ({ keywordId: CREATED_ID, ...parents, state: 'PAUSED', keywordText: 'synthetic keyword', matchType: 'EXACT', bid: 1.25 }) },
  { route: 'targets', envelope: 'targetingClauses', filter: 'targetIdFilter',
    input: () => created(plan({ target: { targetType: 'expression', parent: keyword.parent, scope: 'ad_group', polarity: 'positive',
      bid: 1.5, state: 'paused', expression: [{ type: 'asin_same_as', value: 'B000000002' }] } }), TARGET),
    row: () => ({ targetId: CREATED_ID, ...parents, state: 'PAUSED', bid: 1.5, expressionType: 'MANUAL',
      expression: [{ type: 'ASIN_SAME_AS', value: 'B000000002' }], resolvedExpression: [{ type: 'ASIN_SAME_AS', value: 'B000000002' }] }) },
  ...(['ad_group', 'campaign'] as const).flatMap((scope) => {
    const parent = { source: 'plan_node' as const, kind: scope, nodeId: scope === 'campaign' ? CAMPAIGN : GROUP };
    const readParents = scope === 'campaign' ? { campaignId: AMAZON_CAMPAIGN } : parents;
    const negativeKeyword: TargetPayload = { ...keyword, scope, parent, polarity: 'negative', matchType: 'negative_phrase', bid: null };
    const negativeTarget: TargetPayload = { targetType: 'expression', scope, parent, polarity: 'negative', bid: null, state: 'paused',
      expression: [{ type: 'asin_brand_same_as', value: 'synthetic-brand' }] };
    const keywordRoute = scope === 'campaign' ? 'campaignNegativeKeywords' : 'negativeKeywords';
    const targetRoute = scope === 'campaign' ? 'campaignNegativeTargets' : 'negativeTargets';
    const targetEnvelope = scope === 'campaign' ? 'campaignNegativeTargetingClauses' : 'negativeTargetingClauses';
    return [
      { route: keywordRoute, envelope: keywordRoute, filter: scope === 'campaign' ? 'campaignNegativeKeywordIdFilter' : 'negativeKeywordIdFilter',
        input: () => created(plan({ target: negativeKeyword }), TARGET),
        row: () => ({ keywordId: CREATED_ID, ...readParents, state: 'PAUSED', keywordText: 'synthetic keyword', matchType: 'NEGATIVE_PHRASE' }) },
      { route: targetRoute, envelope: targetEnvelope, filter: scope === 'campaign' ? 'campaignNegativeTargetIdFilter' : 'negativeTargetIdFilter',
        input: () => created(plan({ target: negativeTarget, automatic: scope === 'campaign' }), TARGET),
        row: () => ({ targetId: CREATED_ID, ...readParents, state: 'PAUSED',
          expression: [{ type: 'ASIN_BRAND_SAME_AS', value: 'synthetic-brand' }],
          resolvedExpression: [{ type: 'ASIN_BRAND_SAME_AS', value: 'synthetic-brand' }] }) },
    ];
  }),
];

describe('SP created-resource observation', () => {
  it.each(cases)('reads exact $route identity with all states and frozen settings', async (fixture) => {
    const input = fixture.input();
    const before = JSON.stringify(input);
    const run = adapter(input, async () => new Response(JSON.stringify({ [fixture.envelope]: [fixture.row()], totalResults: 1 })));
    const result = await run.client.observeNode(input);
    expect(result).toMatchObject({ observation: 'observed', providerEntityId: CREATED_ID,
      amazonModerationStatus: 'unknown', deliveryStatus: 'unknown', basis: 'provider_result_identity',
      sourceSyncJobId: input.sourceSyncJobId, requestDigest: input.currentEvidence.providerCallIntents.at(-1)!.requestDigest });
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]!.url).toBe(`https://advertising-api.amazon.com/sp/${fixture.route}/list`);
    expect(run.calls[0]!.init).toMatchObject({ method: 'POST', redirect: 'error', headers: {
      'Amazon-Advertising-API-Scope': '900000000001',
    } });
    expect(JSON.parse(String(run.calls[0]!.init?.body))).toEqual({ [fixture.filter]: { include: [CREATED_ID] },
      stateFilter: { include: ['ENABLED', 'PAUSED', 'ARCHIVED'] }, maxResults: 2, includeExtendedDataFields: true });
    expect(JSON.stringify(input)).toBe(before);
    expect(() => prepareSpCreationCall(input, hasher)).toThrow(/not_exclusively_pending/);
    expect(CampaignCreationExecutionEvidence.parse(input.currentEvidence).providerCallIntents).toEqual(input.currentEvidence.providerCallIntents);
  });

  it.each(cases)('distinguishes absent, changed and unusable $route evidence', (fixture) => {
    const call = prepareSpCreationReadback(fixture.input(), hasher);
    const read = (body: unknown, status = 200) => decodeSpCreationReadback(call, status, encode(body));
    expect(read({ [fixture.envelope]: [] })).toBe('not_found');
    expect(read({ [fixture.envelope]: [{ ...fixture.row(), state: 'ENABLED' }] })).toBe('conflict');
    expect(read({ [fixture.envelope]: [{ ...fixture.row(), state: 'ARCHIVED' }] })).toBe('conflict');
    expect(read({})).toBe('pending');
    expect(read({ [fixture.envelope]: [fixture.row(), fixture.row()] })).toBe('pending');
    expect(read({ [fixture.envelope]: [fixture.row()], totalResults: 2 })).toBe('pending');
    expect(read({ [fixture.envelope]: [], nextToken: 'more' })).toBe('pending');
    expect(read({ [fixture.envelope]: [], nextToken: null })).toBe('pending');
    expect(read({ [fixture.envelope]: [] }, 404)).toBe('pending');
  });

  it.each([400, 401, 403, 404, 429, 500, 503])('never retries creation or treats HTTP %s as absence', async (status) => {
    const input = created();
    const run = adapter(input, async () => new Response('{}', { status }));
    expect((await run.client.observeNode(input)).observation).toBe('pending');
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]!.url).toContain('/list');
  });

  it('observes after write expiry and preserves uncertainty on a later failed read', async () => {
    const input = created();
    let now = Date.parse('2026-09-06T14:00:00.000Z');
    let fail = false;
    const run = adapter(input, async () => {
      if (fail) throw new Error('synthetic read failure');
      return new Response(JSON.stringify({ campaigns: [campaignRow()] }));
    }, () => now);
    const first = await run.client.observeNode(input);
    const accounting = { ...input.currentEvidence.snapshot.accounting, pendingObservation: 0, observed: 1 };
    input.currentEvidence = CampaignCreationExecutionEvidence.parse({ ...input.currentEvidence,
      observations: [...input.currentEvidence.observations, first],
      snapshot: { status: deriveCampaignCreationExecutionStatus(accounting), accounting } });
    fail = true; now += 1000;
    expect((await run.client.observeNode(input)).observation).toBe('pending');
    expect(input.currentEvidence.observations).toContainEqual(first);
    expect(run.calls).toHaveLength(2);
    expect(run.calls.every((call) => call.url.endsWith('/list'))).toBe(true);
  });

  it.each(['scope', 'receipt', 'job', 'node', 'request', 'position', 'coherent_request', 'coherent_position', 'sourceJob', 'clock', 'ambiguous', 'missing_result'])(
    'refuses changed %s before token or provider I/O', async (change) => {
      const input = created();
      const run = adapter(input, undefined, () => change === 'clock' ? NaN : NOW);
      if (change === 'scope' && input.plan.schemaVersion === 'openspell.campaign-creation-plan.v2') input.plan.providerScope.amazonProfileId = 'different';
      if (change === 'receipt') input.authorization.generation = id(991);
      if (change === 'job') input.job.orgId = id(991);
      if (change === 'node') input.nodeId = id(991);
      if (change === 'sourceJob') input.sourceSyncJobId = 'not-a-uuid';
      if (change === 'request') input.currentEvidence.providerCallIntents.at(-1)!.requestDigest = zero;
      if (change === 'position') input.currentEvidence.providerCallIntents.at(-1)!.positions[0]!.requestDigest = zero;
      if (change === 'coherent_request' || change === 'coherent_position') {
        const intent = input.currentEvidence.providerCallIntents.at(-1)!;
        const result = input.currentEvidence.providerResults.at(-1)!;
        if (result.effect !== 'irreversible_create') throw new Error('synthetic create result missing');
        if (change === 'coherent_request') { intent.requestDigest = zero; result.requestDigest = zero; }
        else { intent.positions[0]!.requestDigest = zero; result.nodeRequestDigest = zero; }
        expect(CampaignCreationExecutionEvidence.safeParse(input.currentEvidence).success).toBe(true);
      }
      if (change === 'ambiguous') {
        input.currentEvidence.providerResults = input.currentEvidence.providerResults.map((result) => result.nodeId === CAMPAIGN
          ? { ...result, outcome: 'ambiguous', providerEntityId: null } as typeof result : result);
        const accounting = { ...input.currentEvidence.snapshot.accounting, succeeded: 0, ambiguous: 1 };
        input.currentEvidence.snapshot = { status: deriveCampaignCreationExecutionStatus(accounting), accounting };
      }
      if (change === 'missing_result') {
        input.currentEvidence.providerResults = input.currentEvidence.providerResults.filter((result) => result.nodeId !== CAMPAIGN);
        const accounting = { ...input.currentEvidence.snapshot.accounting, succeeded: 0, ambiguous: 1 };
        input.currentEvidence.snapshot = { status: deriveCampaignCreationExecutionStatus(accounting), accounting };
        expect(CampaignCreationExecutionEvidence.safeParse(input.currentEvidence).success).toBe(true);
      }
      await expect(run.client.observeNode(input)).rejects.toThrow('invalid observation artifacts');
      expect(run.token).not.toHaveBeenCalled();
      expect(run.calls).toEqual([]);
    },
  );

  it('can read an already admitted child after its parent conflicts, without erasing history', async () => {
    const input = created(plan(), GROUP);
    const prior = input.currentEvidence.observations[0]!;
    const accounting = { ...input.currentEvidence.snapshot.accounting, observed: 0, observationConflict: 1 };
    input.currentEvidence = CampaignCreationExecutionEvidence.parse({ ...input.currentEvidence,
      observations: [...input.currentEvidence.observations, { ...prior, observation: 'conflict',
        observedAt: '2026-09-06T12:03:30.000Z' }],
      snapshot: { status: deriveCampaignCreationExecutionStatus(accounting), accounting } });
    const before = JSON.stringify(input);
    const run = adapter(input, async () => new Response(JSON.stringify({ adGroups: [cases[1]!.row()] })));
    expect((await run.client.observeNode(input)).observation).toBe('observed');
    expect(JSON.stringify(input)).toBe(before);
  });

  it('freezes inputs before asynchronous authentication', async () => {
    const input = created();
    const originalJobId = input.sourceSyncJobId;
    const run = adapter(input);
    let release: (value: Response) => void = () => { throw new Error('synthetic token not waiting'); };
    run.token.mockImplementation(() => new Promise<Response>((resolve) => { release = resolve; }));
    const pending = run.client.observeNode(input);
    await vi.waitFor(() => expect(run.token).toHaveBeenCalledTimes(1));
    input.sourceSyncJobId = id(995);
    input.job.orgId = id(995);
    input.currentEvidence.providerCallIntents = [];
    release(new Response(JSON.stringify({ access_token: ['synthetic', 'access'].join('-'), expires_in: 3600 })));
    expect(await pending).toMatchObject({ observation: 'observed', sourceSyncJobId: originalJobId });
    expect(run.calls).toHaveLength(1);
  });

  it.each([
    ['name', 'Changed campaign'], ['targetingType', 'AUTO'], ['startDate', '2026-09-08'],
    ['endDate', '2026-09-10'], ['portfolioId', 'EXTERNAL-PORTFOLIO'], ['autoManageCampaign', true],
    ['budget', { budget: 21, budgetType: 'DAILY' }],
    ['budget', { budget: 20, budgetType: 'DAILY', effectiveBudget: 21 }],
    ['siteRestrictions', ['AMAZON_BUSINESS']],
  ])('exposes a console-originated campaign change in %s', (field, value) => {
    const call = prepareSpCreationReadback(created(), hasher);
    expect(decodeSpCreationReadback(call, 200, encode({ campaigns: [{ ...campaignRow(), [String(field)]: value }] }))).toBe('conflict');
  });

  it.each(['dynamicBidding', 'budget', 'state', 'startDate', 'name'])('keeps missing campaign %s inconclusive', (field) => {
    const row: Record<string, unknown> = campaignRow();
    delete row[field];
    expect(decodeSpCreationReadback(prepareSpCreationReadback(created(), hasher), 200, encode({ campaigns: [row] }))).toBe('pending');
  });

  it('compares keyed placements without inventing omitted percentages', () => {
    const call = prepareSpCreationReadback(created(), hasher);
    const row = campaignRow();
    const read = () => decodeSpCreationReadback(call, 200, encode({ campaigns: [row] }));
    row.dynamicBidding.placementBidding.reverse();
    expect(read()).toBe('observed');
    row.dynamicBidding.placementBidding[0]!.percentage = 11;
    expect(read()).toBe('conflict');
    row.dynamicBidding.placementBidding.pop();
    expect(read()).toBe('pending');
    row.dynamicBidding.placementBidding.push(row.dynamicBidding.placementBidding[0]!);
    expect(read()).toBe('pending');
  });

  it('keeps unverified optional campaign controls inconclusive', () => {
    const call = prepareSpCreationReadback(created(), hasher);
    for (const controls of [{ offAmazonSettings: {} }, { marketplaceBudgetAllocation: [] }, { unexpectedMutableField: true }]) {
      expect(decodeSpCreationReadback(call, 200, encode({ campaigns: [{ ...campaignRow(), ...controls }] }))).toBe('pending');
    }
    expect(decodeSpCreationReadback(call, 200, encode({ campaigns: [{ ...campaignRow(), endDate: null, autoManageCampaign: false }] }))).toBe('observed');
  });

  it('detects removal or change of a planned end date', () => {
    const call = prepareSpCreationReadback(created(plan({ campaign: {
      schedule: { type: 'calendar_dates', startDate: '2026-09-07', endDate: '2026-09-10' },
    } })), hasher);
    for (const endDate of [undefined, null, '2026-09-11']) {
      expect(decodeSpCreationReadback(call, 200,
        encode({ campaigns: [{ ...campaignRow(), endDate }] }))).toBe('conflict');
    }
    expect(decodeSpCreationReadback(call, 200,
      encode({ campaigns: [{ ...campaignRow(), endDate: '2026-09-10' }] }))).toBe('observed');
  });

  it.each(cases.filter((fixture) => fixture.route.endsWith('Targets') || fixture.route === 'targets'))(
    'requires valid resolved predicates before observing $route', (fixture) => {
      const call = prepareSpCreationReadback(fixture.input(), hasher);
      const read = (resolvedExpression: unknown) => decodeSpCreationReadback(call, 200,
        encode({ [fixture.envelope]: [{ ...fixture.row(), resolvedExpression }] }));
      const predicate = { type: 'ASIN_SAME_AS', value: 'B000000002' };
      expect(read([{ ...predicate, type: 'NOT_A_PROVIDER_PREDICATE' }])).toBe('pending');
      expect(read(Array.from({ length: 1001 }, () => predicate))).toBe('pending');
      expect(read(Array.from({ length: 1000 }, () => predicate))).toBe('observed');
      expect(read([{ ...predicate, type: 'ASIN_CATEGORY_SAME_AS' }]))
        .toBe(fixture.route === 'targets' ? 'observed' : 'pending');
    },
  );

  it.each([
    { placement: 'NOT_A_PROVIDER_PLACEMENT', percentage: 0 },
    { placement: 'SITE_AMAZON_BUSINESS', percentage: 0.5 },
    { placement: 'SITE_AMAZON_BUSINESS', percentage: -1 },
    { placement: 'SITE_AMAZON_BUSINESS', percentage: 901 },
  ])('keeps malformed extra placement evidence inconclusive: %j', (extra) => {
    const row = campaignRow();
    row.dynamicBidding.placementBidding.push(extra);
    expect(decodeSpCreationReadback(prepareSpCreationReadback(created(), hasher), 200,
      encode({ campaigns: [row] }))).toBe('pending');
  });

  it('distinguishes a valid added placement from a rounded malformed percentage', () => {
    const call = prepareSpCreationReadback(created(), hasher);
    const row = campaignRow();
    row.dynamicBidding.placementBidding.push({ placement: 'SITE_AMAZON_BUSINESS', percentage: 900 });
    const source = JSON.stringify({ campaigns: [row] });
    expect(decodeSpCreationReadback(call, 200, new TextEncoder().encode(source))).toBe('conflict');
    expect(decodeSpCreationReadback(call, 200,
      new TextEncoder().encode(source.replace('"percentage":900', '"percentage":900.0000000000000001')))).toBe('pending');
  });

  it('does not call malformed or unverified extra controls a confirmed conflict', () => {
    const call = prepareSpCreationReadback(created(), hasher);
    for (const siteRestrictions of [[null], ['NOT_A_SITE'], ['AMAZON_BUSINESS', 'AMAZON_HAUL']]) {
      expect(decodeSpCreationReadback(call, 200,
        encode({ campaigns: [{ ...campaignRow(), siteRestrictions }] }))).toBe('pending');
    }
    for (const shopperCohortBidding of [[null], [{ shopperCohortType: 'AUDIENCE_SEGMENT' }]]) {
      const row = campaignRow();
      expect(decodeSpCreationReadback(call, 200, encode({ campaigns: [{ ...row,
        dynamicBidding: { ...row.dynamicBidding, shopperCohortBidding } }] }))).toBe('pending');
    }
  });

  it.each(cases.filter((fixture) => fixture.route !== 'campaigns'))('detects exact parent changes on $route', (fixture) => {
    const call = prepareSpCreationReadback(fixture.input(), hasher);
    expect(decodeSpCreationReadback(call, 200, encode({ [fixture.envelope]: [{ ...fixture.row(), campaignId: 'OTHER-CAMPAIGN' }] }))).toBe('conflict');
  });

  it('keeps seller SKU and vendor ASIN requirements distinct', () => {
    const seller = prepareSpCreationReadback(created(plan(), AD), hasher);
    const vendor = prepareSpCreationReadback(created(plan({ accountType: 'vendor' }), AD), hasher);
    const row = { adId: CREATED_ID, ...parents, state: 'PAUSED', asin: 'B000000001' };
    expect(decodeSpCreationReadback(seller, 200, encode({ productAds: [row] }))).toBe('pending');
    expect(decodeSpCreationReadback(vendor, 200, encode({ productAds: [row] }))).toBe('observed');
    expect(decodeSpCreationReadback(vendor, 200, encode({ productAds: [{ ...row, asin: 'B000000002' }] }))).toBe('conflict');
  });

  it('distinguishes an inherited bid from an equal explicit bid and preserves numeric precision', () => {
    const explicit = prepareSpCreationReadback(created(plan(), TARGET), hasher);
    const inherited = prepareSpCreationReadback(created(plan({ target: { ...keyword, bid: null } }), TARGET), hasher);
    const row = { keywordId: CREATED_ID, ...parents, state: 'PAUSED', keywordText: 'synthetic keyword', matchType: 'EXACT' };
    expect(decodeSpCreationReadback(explicit, 200, encode({ keywords: [row] }))).toBe('conflict');
    expect(decodeSpCreationReadback(inherited, 200, encode({ keywords: [row] }))).toBe('observed');
    expect(decodeSpCreationReadback(inherited, 200, encode({ keywords: [{ ...row, bid: 1.25 }] }))).toBe('conflict');
    const source = JSON.stringify({ keywords: [{ ...row, bid: 1.25 }] });
    for (const spelling of ['1.250', '125e-2', '0.125e1']) {
      expect(decodeSpCreationReadback(explicit, 200, new TextEncoder().encode(source.replace('1.25', spelling)))).toBe('observed');
    }
    expect(decodeSpCreationReadback(explicit, 200, new TextEncoder().encode(source.replace('1.25', '1.2500000000000000001')))).toBe('conflict');
  });

  it.each(['numericId', 'duplicateKey', 'invalidUtf8', 'bom', 'tooDeep', 'tooLarge', 'wrongId', 'wrongCount'])(
    'keeps %s response evidence inconclusive', (failure) => {
      const call = prepareSpCreationReadback(created(), hasher);
      let body = encode({ campaigns: [campaignRow()] });
      const source = new TextDecoder().decode(body);
      if (failure === 'numericId') body = new TextEncoder().encode(source.replace(`"${CREATED_ID}"`, CREATED_ID));
      if (failure === 'duplicateKey') body = new TextEncoder().encode(source.replace('"state":"PAUSED"', '"state":"ENABLED","state":"PAUSED"'));
      if (failure === 'invalidUtf8') body = new Uint8Array([0xff]);
      if (failure === 'bom') body = new Uint8Array([0xef, 0xbb, 0xbf, ...body]);
      if (failure === 'tooDeep') body = new TextEncoder().encode('['.repeat(66) + '0' + ']'.repeat(66));
      if (failure === 'tooLarge') body = new Uint8Array(1_048_577);
      if (failure === 'wrongId') body = encode({ campaigns: [{ ...campaignRow(), campaignId: 'UNRELATED-ID' }] });
      if (failure === 'wrongCount') body = new TextEncoder().encode(`{"campaigns":[],"totalResults":0.0000000000000000001}`);
      expect(decodeSpCreationReadback(call, 200, body)).toBe('pending');
    },
  );
});
