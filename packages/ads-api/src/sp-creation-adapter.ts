/** Inert, worker-only transport. One POST per invocation; durable reservation belongs to the worker. */
import {
  CampaignCreationProviderResult, CampaignCreationProviderScope, CampaignCreationSha256,
  CampaignCreationResourceObservation, verifyCampaignCreationObservationArtifacts,
  verifyCampaignCreationProviderCallArtifacts,
  type CampaignCreationPlan, type CampaignCreationAuthorizationReceipt, type CampaignCreationDispatchJob,
  type CampaignCreationExecutionEvidence, type CampaignCreationProviderCallIntent,
  type CampaignCreationSha256Hasher,
  type CampaignCreationObserveJob,
} from '@wizard-ads/shared';
import { TokenProvider } from './auth.js';
import { createHttpContext } from './context.js';
import { adsHeaders } from './headers.js';
import { httpRequestOnce } from './http.js';
import { SP_WRITE_ENDPOINTS } from './endpoints.js';
import { hostFor } from './regions.js';
import { prepareSpCreationCall, prepareSpCreationReadback, type SpCreationCompiledCall } from './sp-creation-codec.js';
import { decodeSpCreationResponse } from './sp-creation-response.js';
import { decodeSpCreationReadback, spCreationReadbackRequest } from './sp-creation-readback.js';
import { identity } from './sp-creation-json.js';
import type { AdsApiClientOptions } from './types.js';

export interface SpCreationAdapter {
  /** Read the exactly correlated created identity; never searches for or retries an uncertain create. */
  observeNode(input: {
    plan: CampaignCreationPlan;
    authorization: CampaignCreationAuthorizationReceipt;
    job: CampaignCreationObserveJob;
    currentEvidence: CampaignCreationExecutionEvidence;
    nodeId: string;
    sourceSyncJobId: string;
  }, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<CampaignCreationResourceObservation>;
  prepareNode(input: {
    plan: CampaignCreationPlan;
    currentEvidence: CampaignCreationExecutionEvidence;
    nodeId: string;
  }): Pick<SpCreationCompiledCall, 'requestDigest' | 'positions'>;
  /** Only the winner of a newly committed reservation may invoke this operation. */
  executeOneAttempt(input: {
    plan: CampaignCreationPlan;
    authorization: CampaignCreationAuthorizationReceipt;
    job: CampaignCreationDispatchJob;
    evidenceBeforeReservation: CampaignCreationExecutionEvidence;
    intent: CampaignCreationProviderCallIntent;
  }, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<
    Extract<CampaignCreationProviderResult, { effect: 'irreversible_create' }>
  >;
}

function refusal(): Error { return new Error('SP creation adapter refused invalid dispatch artifacts'); }

export function createSpCreationAdapter(
  rawOptions: AdsApiClientOptions,
  dependencies: { hasher: CampaignCreationSha256Hasher; providerScope: CampaignCreationProviderScope },
): SpCreationAdapter {
  const options = { ...rawOptions, credentials: { ...rawOptions.credentials } };
  let scope: CampaignCreationProviderScope;
  const hasher = dependencies.hasher;
  const digest = (input: string) => CampaignCreationSha256.parse(hasher.digest(input));
  try {
    scope = CampaignCreationProviderScope.parse(dependencies.providerScope);
    if (scope.region !== options.region || hasher.algorithm !== 'sha256') throw refusal();
    digest('openspell.sp-creation-hasher-check.v1');
  } catch { throw refusal(); }
  const ctx = createHttpContext(options.region, options);
  const tokens = new TokenProvider(options.credentials, options);
  const now = options.now ?? Date.now;
  const timestamp = () => new Date(now()).toISOString();
  const compile = (input: Parameters<SpCreationAdapter['prepareNode']>[0]) => {
    const call = prepareSpCreationCall(input, hasher);
    if (JSON.stringify(call.providerScope) !== JSON.stringify(scope)) throw refusal();
    return call;
  };
  return {
    async observeNode(input, readOptions = {}) {
      const denied = () => new Error('SP creation adapter refused invalid observation artifacts');
      let call: ReturnType<typeof prepareSpCreationReadback>;
      let verified: ReturnType<typeof verifyCampaignCreationObservationArtifacts>;
      let startedAt: string;
      const timeoutMs = readOptions.timeoutMs ?? 35_000;
      try {
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw denied();
        startedAt = timestamp();
        call = prepareSpCreationReadback(input, hasher);
        if (!identity(call.providerEntityId) || JSON.stringify(call.providerScope) !== JSON.stringify(scope)) throw denied();
        const intent = input.currentEvidence.providerCallIntents.find((candidate) => (
          candidate.positions.some((position) => position.nodeId === input.nodeId)
        ));
        if (intent === undefined) throw denied();
        const position = call.positions[0];
        const candidate = CampaignCreationResourceObservation.parse({
          planId: intent.planId, nodeId: position.nodeId, executionId: intent.executionId,
          authorizationId: intent.authorizationId, generation: intent.generation,
          attemptId: intent.attemptId, providerCallId: intent.providerCallId,
          nodeFingerprint: position.nodeFingerprint, requestDigest: intent.requestDigest,
          nodeRequestDigest: position.requestDigest, basis: 'provider_result_identity',
          providerEntityId: call.providerEntityId, observation: 'pending',
          amazonModerationStatus: 'unknown', deliveryStatus: 'unknown',
          observedAt: startedAt, sourceSyncJobId: input.sourceSyncJobId,
        });
        verified = verifyCampaignCreationObservationArtifacts(input.plan, input.authorization, input.job,
          input.currentEvidence, candidate, startedAt, hasher);
      } catch { throw denied(); }
      const request = spCreationReadbackRequest(call);
      let observation: CampaignCreationResourceObservation['observation'] = 'pending';
      try {
        const headers = adsHeaders((_force, signal) => tokens.getAccessToken(signal), {
          clientId: options.credentials.clientId, profileId: scope.amazonProfileId,
          contentType: request.mediaType, accept: request.mediaType,
          ...(options.userAgent === undefined ? {} : { userAgent: options.userAgent }),
        });
        const response = await httpRequestOnce(ctx, { method: 'POST',
          url: `${hostFor(scope.region)}${request.path}`, body: request.body, headers,
          timeoutMs, maxResponseBytes: 1_048_576, redirect: 'error',
          ...(readOptions.signal === undefined ? {} : { signal: readOptions.signal }),
        });
        observation = decodeSpCreationReadback(call, response.status, response.body);
      } catch { /* A failed read is inconclusive; it cannot establish absence. */ }
      try {
        const completedAt = timestamp();
        if (Date.parse(completedAt) < Date.parse(startedAt)) throw denied();
        return verifyCampaignCreationObservationArtifacts(verified.plan, verified.authorization,
          verified.job, verified.currentEvidence,
          { ...verified.observation, observation, observedAt: completedAt }, completedAt, hasher).observation;
      } catch { throw denied(); }
    },
    prepareNode(input) {
      try {
        const call = compile(input);
        return Object.freeze({ requestDigest: call.requestDigest, positions: call.positions });
      } catch { throw refusal(); }
    },
    async executeOneAttempt(input, attemptOptions = {}) {
      let verified: ReturnType<typeof verifyCampaignCreationProviderCallArtifacts>;
      let call: SpCreationCompiledCall;
      let startedAt: string;
      const timeoutMs = attemptOptions.timeoutMs ?? 35_000;
      try {
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw refusal();
        startedAt = timestamp();
        verified = verifyCampaignCreationProviderCallArtifacts(input.plan, input.authorization, input.job,
          input.evidenceBeforeReservation, input.intent, startedAt, hasher);
        if (verified.intent.positions.length !== 1) throw refusal();
        call = compile({ plan: verified.plan, currentEvidence: verified.currentEvidence,
          nodeId: verified.intent.positions[0]!.nodeId });
        if (call.requestDigest !== verified.intent.requestDigest
          || JSON.stringify(call.positions) !== JSON.stringify(verified.intent.positions)) throw refusal();
      } catch { throw refusal(); }
      const intent = verified.intent;
      const position = intent.positions[0]!;
      // Compiler-owned JSON, not a provider body or caller-supplied wire artifact.
      const request = JSON.parse(call.body) as Record<string, Record<string, unknown>[]>;
      const item = request[SP_WRITE_ENDPOINTS[call.kind].requestKey]![0]!;
      const expectedParents = Object.fromEntries(['campaignId', 'adGroupId'].flatMap((key) => (
        typeof item[key] === 'string' ? [[key, item[key]]] : []
      )));
      const fallback = CampaignCreationProviderResult.parse({
        effect: 'irreversible_create', planId: intent.planId, nodeId: position.nodeId,
        executionId: intent.executionId, attemptId: intent.attemptId, providerCallId: intent.providerCallId,
        nodeFingerprint: position.nodeFingerprint, requestIndex: position.requestIndex,
        requestDigest: intent.requestDigest, nodeRequestDigest: position.requestDigest,
        outcome: 'ambiguous', providerEntityId: null, providerEntityVersion: null,
        providerCode: null, sanitizedMessage: 'Creation outcome is uncertain; reconciliation is required.',
        providerRequestId: null, responseDigest: null, startedAt, completedAt: startedAt,
      });
      if (fallback.effect !== 'irreversible_create') throw refusal();
      const completion = () => {
        try { return new Date(Math.max(now(), Date.parse(startedAt))).toISOString(); }
        catch { return startedAt; }
      };
      let providerAttemptStarted = false;
      const checkDeadline = () => {
        const dispatchTime = now();
        if (!Number.isFinite(dispatchTime) || dispatchTime < Date.parse(startedAt)
          || dispatchTime >= Date.parse(verified.authorization.expiresAt)
          || dispatchTime >= Date.parse(verified.plan.expiresAt)) throw refusal();
      };
      try {
        const getHeaders = adsHeaders((_force, signal) => tokens.getAccessToken(signal), {
          clientId: options.credentials.clientId, profileId: scope.amazonProfileId,
          contentType: call.mediaType, accept: call.mediaType,
          ...(options.userAgent === undefined ? {} : { userAgent: options.userAgent }),
        });
        const response = await httpRequestOnce({ ...ctx, fetch: (url, init) => {
          // Header resolution itself is awaited by HTTP. Close that microtask
          // gap with no await between this final check and the actual fetch.
          checkDeadline();
          providerAttemptStarted = true;
          return ctx.fetch(url, init);
        } }, {
          method: 'POST', url: `${hostFor(scope.region)}${call.path}`, body: call.body,
          headers: async (force, signal) => {
            const headers = await getHeaders(force, signal);
            // Token work may cross the deadline. No campaign request may start afterward.
            checkDeadline();
            return headers;
          },
          timeoutMs, maxResponseBytes: 1_048_576, redirect: 'error',
          ...(attemptOptions.signal === undefined ? {} : { signal: attemptOptions.signal }),
        });
        const decoded = decodeSpCreationResponse(call.kind, response.status, response.body, expectedParents);
        const responseDigest = digest(JSON.stringify(['openspell.sp-creation-response.v1',
          intent.requestDigest, response.status,
          Array.from(response.body, (byte) => byte.toString(16).padStart(2, '0')).join('')]));
        const result = CampaignCreationProviderResult.parse({ ...fallback, ...decoded, responseDigest,
          sanitizedMessage: decoded.outcome === 'succeeded' ? null
            : decoded.outcome === 'authoritative_rejected' ? 'Amazon refused this creation request.'
              : fallback.sanitizedMessage,
          completedAt: completion() });
        if (result.effect !== 'irreversible_create') throw refusal();
        return result;
      } catch {
        return { ...fallback, completedAt: completion(),
          sanitizedMessage: !providerAttemptStarted
            ? 'No campaign request was sent; the reserved intent requires reconciliation.'
            : fallback.sanitizedMessage };
      }
    },
  };
}
