import { describe, expect, it, vi } from 'vitest';
import { CampaignCreationAuthorizationReceipt, CampaignCreationProviderCallIntent,
  CampaignCreationDispatchJob, CampaignCreationProviderResult,
  type CampaignCreationPlanV2, type CampaignCreationProviderScope } from '@wizard-ads/shared';
import { createSpCreationAdapter, type SpCreationAdapter } from './sp-creation-adapter.js';
import * as rootApi from './index.js';
import { plan, evidence, hasher, id, zero, CAMPAIGN, GROUP, AD, TARGET, keyword,
  type TargetPayload } from './__fixtures__/sp-creation.js';
import type { FetchLike } from './types.js';

const CREATED_ID = '900719925474099398765';
const START = Date.parse('2026-09-06T12:03:00.000Z');
const credentials = { clientId: 'synthetic-client', clientSecret: ['synthetic', 'secret'].join('-'),
  refreshToken: ['synthetic', 'refresh'].join('-') };
const json = (body: unknown, status = 207) => new Response(JSON.stringify(body), { status });
const campaignSuccess = () => json({ campaigns: { success: [{ index: 0, campaignId: CREATED_ID }] } });

function setup(fixture = plan(), provider: FetchLike = async () => campaignSuccess(), extra: {
  token?: () => Promise<Response>; scope?: CampaignCreationProviderScope; clock?: () => number;
} = {}) {
  const providerCalls: { url: string; init?: RequestInit }[] = [];
  const token = vi.fn(async () => extra.token === undefined
    ? json({ access_token: ['synthetic', 'access'].join('-'), expires_in: 3600 }, 200) : extra.token());
  const adapter = createSpCreationAdapter({ region: 'NA', credentials, now: extra.clock ?? (() => START),
    retry: { maxAttempts: 5 }, sleep: async () => undefined,
    fetch: async (url, init) => {
      if (url === 'https://api.amazon.com/auth/o2/token') return token();
      providerCalls.push({ url, ...(init === undefined ? {} : { init }) });
      return provider(url, init);
    },
  }, { hasher, providerScope: extra.scope ?? fixture.providerScope });
  return { adapter, providerCalls, token };
}

function input(adapter: SpCreationAdapter, fixture = plan(), nodeId = CAMPAIGN) {
  const currentEvidence = evidence(fixture, nodeId);
  const prepared = adapter.prepareNode({ plan: fixture, currentEvidence, nodeId });
  const authorization = CampaignCreationAuthorizationReceipt.parse({
    authorizationId: id(6), executionId: id(5), generation: id(7),
    schemaVersion: fixture.schemaVersion, planId: fixture.id, planFingerprint: fixture.fingerprint,
    orgId: fixture.orgId, profileId: fixture.profileId, marketplaceId: fixture.marketplaceId,
    adProduct: fixture.adProduct, apiDialect: fixture.apiDialect, expiresAt: fixture.expiresAt,
    expectedCounts: fixture.counts, noRollbackAcknowledgement: fixture.noRollbackAcknowledgement,
    confirmationVersion: 'openspell.campaign-creation.no-delete-rollback.v1',
    approvedBy: id(9), approvedAt: '2026-09-06T12:01:15.000Z', gateSnapshotDigest: zero,
  });
  return { plan: fixture, authorization,
    job: CampaignCreationDispatchJob.parse({ type: 'campaign_creation.dispatch', orgId: fixture.orgId,
      profileId: fixture.profileId, planId: fixture.id, planFingerprint: fixture.fingerprint,
      executionId: id(5), authorizationId: id(6), generation: id(7) }),
    evidenceBeforeReservation: currentEvidence,
    intent: CampaignCreationProviderCallIntent.parse({ planId: fixture.id, planFingerprint: fixture.fingerprint,
      executionId: id(5), authorizationId: id(6), generation: id(7), attemptId: id(500), providerCallId: id(501),
      requestDigest: prepared.requestDigest, positions: prepared.positions, recordedAt: '2026-09-06T12:02:59.000Z' }),
  };
}

describe('inert SP creation adapter', () => {
  it('prepares without credentials or I/O and is absent from the root export', () => {
    const run = setup();
    const prepared = run.adapter.prepareNode({ plan: plan(), currentEvidence: evidence(plan(), CAMPAIGN), nodeId: CAMPAIGN });
    expect(Object.keys(prepared).sort()).toEqual(['positions', 'requestDigest']);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.positions)).toBe(true);
    expect(run.token).not.toHaveBeenCalled();
    expect(run.providerCalls).toEqual([]);
    expect(rootApi).not.toHaveProperty('createSpCreationAdapter');
  });

  it('sends one paused campaign with frozen profile headers and returns exact bound acceptance evidence', async () => {
    const run = setup();
    const request = input(run.adapter);
    const before = JSON.stringify(request);
    const result = await run.adapter.executeOneAttempt(request);
    expect(CampaignCreationProviderResult.parse(result)).toEqual(result);
    expect(result).toMatchObject({ outcome: 'succeeded', providerEntityId: CREATED_ID,
      planId: request.plan.id, executionId: request.intent.executionId, attemptId: request.intent.attemptId,
      providerCallId: request.intent.providerCallId, nodeFingerprint: request.intent.positions[0]!.nodeFingerprint,
      nodeId: CAMPAIGN, requestIndex: 0, requestDigest: request.intent.requestDigest,
      nodeRequestDigest: request.intent.positions[0]!.requestDigest,
      providerRequestId: null, sanitizedMessage: null });
    expect(result.responseDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(run.providerCalls).toHaveLength(1);
    expect(run.token).toHaveBeenCalledTimes(1);
    const call = run.providerCalls[0]!;
    expect(call.url).toBe('https://advertising-api.amazon.com/sp/campaigns');
    expect(call.init).toMatchObject({ method: 'POST', redirect: 'error', headers: {
      'Amazon-Advertising-API-Scope': request.plan.providerScope.amazonProfileId,
      Accept: 'application/vnd.spCampaign.v3+json', 'Content-Type': 'application/vnd.spCampaign.v3+json',
    } });
    expect(JSON.parse(String(call.init?.body)).campaigns).toHaveLength(1);
    expect(JSON.parse(String(call.init?.body)).campaigns[0].state).toBe('PAUSED');
    expect(JSON.stringify(request)).toBe(before);
  });

  const targetCases: readonly (readonly [string, string, TargetPayload])[] = [
    ['keywords', 'keywordId', keyword],
    ['targets', 'targetId', { targetType: 'expression', parent: keyword.parent, scope: 'ad_group',
      polarity: 'positive', bid: 1.5, state: 'paused', expression: [{ type: 'asin_same_as', value: 'B000000002' }] }],
    ...(['ad_group', 'campaign'] as const).flatMap((scope): (readonly [string, string, TargetPayload])[] => {
      const parent = { source: 'plan_node' as const, kind: scope, nodeId: scope === 'campaign' ? CAMPAIGN : GROUP };
      return [
        [scope === 'campaign' ? 'campaignNegativeKeywords' : 'negativeKeywords',
          scope === 'campaign' ? 'campaignNegativeKeywordId' : 'negativeKeywordId',
          { ...keyword, scope, parent, polarity: 'negative', matchType: 'negative_phrase', bid: null }],
        [scope === 'campaign' ? 'campaignNegativeTargets' : 'negativeTargets',
          scope === 'campaign' ? 'campaignNegativeTargetingClauseId' : 'targetId',
          { targetType: 'expression', scope, parent, polarity: 'negative', bid: null, state: 'paused',
            expression: [{ type: 'asin_brand_same_as', value: 'synthetic-brand' }] }],
      ];
    }),
  ];
  it.each(targetCases)('sends one exact %s request from observed dependencies', async (route, idKey, target) => {
    const fixture = plan({ target, automatic: route === 'campaignNegativeTargets' });
    const envelope = route === 'targets' ? 'targetingClauses'
      : route === 'negativeTargets' ? 'negativeTargetingClauses'
        : route === 'campaignNegativeTargets' ? 'campaignNegativeTargetingClauses' : route;
    const run = setup(fixture, async () => json({ [envelope]: { success: [{ index: 0, [idKey]: CREATED_ID }] } }));
    expect((await run.adapter.executeOneAttempt(input(run.adapter, fixture, TARGET))).outcome).toBe('succeeded');
    expect(run.providerCalls).toHaveLength(1);
    expect(run.providerCalls[0]!.url).toBe(`https://advertising-api.amazon.com/sp/${route}`);
    expect(JSON.parse(String(run.providerCalls[0]!.init?.body))[envelope]).toHaveLength(1);
  });

  it.each([[GROUP, 'adGroups', 'adGroupId'], [AD, 'productAds', 'adId']] as const)(
    'creates child %s only from verified parent observations', async (nodeId, route, idKey) => {
      const fixture = plan();
      const run = setup(fixture, async () => json({ [route]: { success: [{ index: 0, [idKey]: CREATED_ID }] } }));
      expect((await run.adapter.executeOneAttempt(input(run.adapter, fixture, nodeId))).outcome).toBe('succeeded');
      expect(run.providerCalls).toHaveLength(1);
      expect(run.providerCalls[0]!.url).toBe(`https://advertising-api.amazon.com/sp/${route}`);
    });

  it.each(['plan', 'authority', 'tenant', 'generation', 'node_digest', 'request_digest', 'position_digest',
    'expiry', 'evidence', 'position', 'clock'])(
    'refuses changed %s before token resolution or campaign I/O', async (change) => {
      const run = setup(undefined, undefined, { clock: () => change === 'clock' ? NaN : START });
      const request = input(run.adapter);
      if (change === 'plan') request.plan.fingerprint = zero;
      if (change === 'authority') request.authorization.planFingerprint = zero;
      if (change === 'tenant') request.job.orgId = id(888);
      if (change === 'generation') request.intent.generation = id(888);
      if (change === 'node_digest') request.intent.positions[0]!.nodeFingerprint = zero;
      if (change === 'request_digest') request.intent.requestDigest = zero;
      if (change === 'position_digest') request.intent.positions[0]!.requestDigest = zero;
      if (change === 'expiry') request.authorization.expiresAt = '2026-09-06T12:02:00.000Z';
      if (change === 'evidence') request.evidenceBeforeReservation.nonProviderDispositions = [];
      if (change === 'position') request.intent.positions[0]!.requestIndex = 1;
      await expect(run.adapter.executeOneAttempt(request)).rejects.toThrow('refused invalid dispatch artifacts');
      expect(run.token).not.toHaveBeenCalled();
      expect(run.providerCalls).toEqual([]);
    });

  it.each(['amazonProfileId', 'connectionId', 'marketplaceId', 'currencyCode', 'accountType'] as const)(
    'binds the credential grant to the frozen %s', async (key) => {
      const fixture = plan();
      const request = input(setup(fixture).adapter, fixture);
      const scope = { ...fixture.providerScope, [key]: key === 'connectionId' ? id(999)
        : key === 'amazonProfileId' ? '900000000999' : key === 'currencyCode' ? 'CAD' : key === 'accountType' ? 'vendor' : 'other-synthetic-id' };
      const run = setup(fixture, undefined, { scope });
      await expect(run.adapter.executeOneAttempt(request)).rejects.toThrow('refused');
      expect(run.token).not.toHaveBeenCalled();
      expect(run.providerCalls).toEqual([]);
    });

  it('refuses a region mismatch during inert construction', () => {
    expect(() => setup(undefined, undefined, { scope: { ...plan().providerScope, region: 'EU' } })).toThrow('refused');
  });

  it('rechecks expiry after asynchronous token work before sending a campaign request', async () => {
    let clock = START;
    const run = setup(undefined, undefined, { clock: () => clock, token: async () => {
      clock = Date.parse(plan().expiresAt);
      return json({ access_token: ['synthetic', 'access'].join('-'), expires_in: 3600 }, 200);
    } });
    const result = await run.adapter.executeOneAttempt(input(run.adapter));
    expect(result.outcome).toBe('ambiguous');
    expect(result.sanitizedMessage).toContain('No campaign request was sent');
    expect(run.token).toHaveBeenCalledTimes(1);
    expect(run.providerCalls).toEqual([]);
  });

  it('uses copied artifacts despite caller mutation during token work', async () => {
    const run = setup(undefined, undefined, { token: async () => {
      request.plan.providerScope.amazonProfileId = 'changed-after-validation';
      request.intent.requestDigest = zero;
      return json({ access_token: ['synthetic', 'access'].join('-'), expires_in: 3600 }, 200);
    } });
    const request = input(run.adapter);
    const originalDigest = request.intent.requestDigest;
    const result = await run.adapter.executeOneAttempt(request);
    expect(result.requestDigest).toBe(originalDigest);
    expect(run.providerCalls[0]!.init?.headers).toMatchObject({ 'Amazon-Advertising-API-Scope': '900000000001' });
  });

  it('refuses expiry in the microtask gap between header resolution and fetch', async () => {
    let clock = START;
    let reads = 0;
    const run = setup(undefined, undefined, { clock: () => {
      reads += 1;
      // Verification, token cache assignment, then the header deadline check.
      if (reads === 3) queueMicrotask(() => { clock = Date.parse(plan().expiresAt); });
      return clock;
    } });
    const result = await run.adapter.executeOneAttempt(input(run.adapter));
    expect(run.providerCalls).toEqual([]);
    expect(result.outcome).toBe('ambiguous');
  });

  it.each([false, true])('checks returned parent identity against the actual request: conflict=%s', async (conflict) => {
    const fixture = plan();
    const run = setup(fixture, async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { adGroups: { campaignId: string }[] };
      return json({ adGroups: { success: [{ index: 0, adGroupId: CREATED_ID,
        adGroup: { adGroupId: CREATED_ID, campaignId: conflict ? '999' : body.adGroups[0]!.campaignId } }] } });
    });
    const result = await run.adapter.executeOneAttempt(input(run.adapter, fixture, GROUP));
    expect(result.outcome).toBe(conflict ? 'ambiguous' : 'succeeded');
    expect(run.providerCalls).toHaveLength(1);
  });

  it.each([400, 401, 403, 415, 429, 500, 503, 200])('makes one attempt for HTTP %i regardless of configured retry policy', async (status) => {
    const codes: Record<number, string> = { 400: 'INVALID_ARGUMENT', 401: 'UNAUTHORIZED',
      403: 'ACCESS_DENIED', 415: 'UNSUPPORTED_MEDIA_TYPE', 429: 'THROTTLED' };
    const run = setup(undefined, async () => json({ code: codes[status] ?? 'INTERNAL_ERROR', message: 'private detail' }, status));
    const result = await run.adapter.executeOneAttempt(input(run.adapter));
    expect(result.outcome).toBe(codes[status] === undefined ? 'ambiguous' : 'authoritative_rejected');
    expect(run.providerCalls).toHaveLength(1);
    expect(run.token).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('private detail');
  });

  it.each(['fetch', 'body', 'oversize', 'malformed', 'timeout', 'duplicates'])(
    'preserves uncertainty after %s failure without another POST', async (failure) => {
      const run = setup(undefined, async () => {
        if (failure === 'fetch') throw new Error('private transport detail');
        if (failure === 'timeout') return new Promise<Response>(() => undefined);
        if (failure === 'body') return new Response(new ReadableStream({ start(controller) {
          controller.error(new Error('private body detail'));
        } }), { status: 207 });
        if (failure === 'oversize') return new Response(' '.repeat(1_048_577), { status: 207 });
        if (failure === 'duplicates') return json({ campaigns: { success: [
          { index: 0, campaignId: CREATED_ID }, { index: 0, campaignId: CREATED_ID }] } });
        return new Response('{', { status: 207 });
      });
      const result = await run.adapter.executeOneAttempt(input(run.adapter), { timeoutMs: failure === 'timeout' ? 10 : 35_000 });
      expect(result.outcome).toBe('ambiguous');
      expect(result.providerEntityId).toBeNull();
      expect(run.providerCalls).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain('private');
    });

  it('closes token failure conservatively and never leaks the underlying error', async () => {
    const run = setup(undefined, undefined, { token: async () => json({ error: 'invalid_grant', error_description: 'private' }, 400) });
    const result = await run.adapter.executeOneAttempt(input(run.adapter));
    expect(result.outcome).toBe('ambiguous');
    expect(result.responseDigest).toBeNull();
    expect(run.providerCalls).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('binds response bytes in the digest without retaining provider text or headers', async () => {
    const results = [];
    for (const detail of ['private one', 'private two', 'private one']) {
      const run = setup(undefined, async () => new Response(JSON.stringify({ code: 'UNAUTHORIZED', message: detail }),
        { status: 401, headers: { 'x-amzn-requestid': detail } }));
      results.push(await run.adapter.executeOneAttempt(input(run.adapter)));
    }
    expect(results[0]!.responseDigest).not.toBe(results[1]!.responseDigest);
    expect(results[0]!.responseDigest).toBe(results[2]!.responseDigest);
    expect(JSON.stringify(results)).not.toContain('private');
  });

  it('refuses already recorded intents rather than manufacturing a pre-reservation witness', async () => {
    const fixture = plan();
    const run = setup(fixture);
    const request = input(run.adapter, fixture, GROUP);
    // Existing campaign is already reserved, succeeded and observed in the valid projection.
    const previous = request.evidenceBeforeReservation.providerCallIntents[0]!;
    request.intent = { ...previous };
    await expect(run.adapter.executeOneAttempt(request)).rejects.toThrow('refused');
    expect(run.providerCalls).toEqual([]);
    expect(run.token).not.toHaveBeenCalled();
  });

  it('does not confuse a successful parent response with observed identity', () => {
    const fixture: CampaignCreationPlanV2 = plan();
    const current = evidence(fixture, GROUP);
    current.observations = current.observations.map((row) => ({ ...row, observation: 'pending', providerEntityId: null }));
    current.snapshot.accounting.observed = 0;
    current.snapshot.accounting.pendingObservation = 1;
    expect(() => setup(fixture).adapter.prepareNode({ plan: fixture, currentEvidence: current, nodeId: GROUP })).toThrow('refused');
  });
});
