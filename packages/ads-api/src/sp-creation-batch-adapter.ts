import { CampaignCreationBatch, CampaignCreationProviderResult, type CampaignCreationBatchObservation,
  type CampaignCreationSha256Hasher } from '@wizard-ads/shared';
import { createHttpContext } from './context.js';
import { TokenProvider } from './auth.js';
import { adsHeaders } from './headers.js';
import { httpRequestOnce } from './http.js';
import { hostFor } from './regions.js';
import { SP_WRITE_ENDPOINTS } from './endpoints.js';
import { prepareSpCreationBatchCall, type SpCreationCompiledCall } from './sp-creation-codec.js';
import { decodeSpCreationResponse } from './sp-creation-response.js';
import { discoverSpCreation } from './sp-creation-discovery.js';
import type { AdsApiClientOptions } from './types.js';

export interface SpCreationBatchAdapter {
  prepare(batch: CampaignCreationBatch, nodeId: string): Pick<SpCreationCompiledCall, 'requestDigest' | 'positions'>;
  execute(batch: CampaignCreationBatch, nodeId: string, signal: AbortSignal): Promise<CampaignCreationProviderResult>;
  observe(batch: CampaignCreationBatch, nodeId: string, signal: AbortSignal): Promise<CampaignCreationBatchObservation>;
}

/** Worker-only; a committed one-shot node reservation is required by execute. */
export function createSpCreationBatchAdapter(options: AdsApiClientOptions,
  hasher: CampaignCreationSha256Hasher): SpCreationBatchAdapter {
  const ctx = createHttpContext(options.region, options);
  const tokens = new TokenProvider(options.credentials, options);
  const now = options.now ?? Date.now;
  const prepare = (batch: CampaignCreationBatch, nodeId: string) => {
    const call = prepareSpCreationBatchCall(batch, nodeId, hasher);
    if (call.providerScope.region !== options.region) throw new Error('Creation provider scope mismatch');
    return call;
  };
  const headers = (call: SpCreationCompiledCall) => adsHeaders((_force, signal) => tokens.getAccessToken(signal), {
    clientId: options.credentials.clientId, profileId: call.providerScope.amazonProfileId,
    contentType: call.mediaType, accept: call.mediaType,
  });
  return {
    prepare,
    async execute(raw, nodeId, signal) {
      const batch = CampaignCreationBatch.parse(raw);
      const call = prepare(batch, nodeId);
      const row = batch.nodes.find((node) => node.nodeId === nodeId)!;
      const intent = row.intent;
      if (!intent || row.result || row.refusal || intent.requestDigest !== call.requestDigest
        || intent.nodeRequestDigest !== call.positions[0].requestDigest) throw new Error('Creation reservation mismatch');
      const startedAt = new Date(now()).toISOString();
      const checkDeadline = () => {
        signal.throwIfAborted();
        if (now() < Date.parse(intent.reservedAt) || now() >= Math.min(Date.parse(intent.deadline), Date.parse(batch.expiresAt))) {
          throw new Error('Creation reservation expired');
        }
      };
      const base = { effect: 'irreversible_create', planId: batch.plan.id, nodeId, executionId: batch.id,
        attemptId: intent.id, providerCallId: intent.id, nodeFingerprint: row.nodeFingerprint, requestIndex: 0,
        requestDigest: intent.requestDigest, nodeRequestDigest: intent.nodeRequestDigest,
        outcome: 'ambiguous', providerEntityId: null, providerEntityVersion: null, providerCode: null,
        sanitizedMessage: 'Creation outcome is uncertain. The worker will read the exact identity before any separately approved retry.',
        providerRequestId: null, responseDigest: null, startedAt, completedAt: startedAt };
      try {
        checkDeadline();
        const request = JSON.parse(call.body) as Record<string, Record<string, unknown>[]>;
        const item = request[SP_WRITE_ENDPOINTS[call.kind].requestKey]![0]!;
        const parents = Object.fromEntries(['campaignId', 'adGroupId'].flatMap((key) => typeof item[key] === 'string' ? [[key, item[key]]] : []));
        const response = await httpRequestOnce({ ...ctx, fetch: (url, init) => { checkDeadline(); return ctx.fetch(url, init); } }, {
          method: 'POST', url: `${hostFor(call.providerScope.region)}${call.path}`, body: call.body,
          headers: headers(call), timeoutMs: Math.max(1, Math.min(35_000, Date.parse(intent.deadline) - now())),
          signal, redirect: 'error', maxResponseBytes: 1_048_576,
        });
        const decoded = decodeSpCreationResponse(call.kind, response.status, response.body, parents);
        return CampaignCreationProviderResult.parse({ ...base, ...decoded,
          sanitizedMessage: decoded.outcome === 'succeeded' ? null : decoded.outcome === 'authoritative_rejected' ? 'Amazon refused this resource.' : base.sanitizedMessage,
          responseDigest: hasher.digest(JSON.stringify([call.requestDigest, response.status, Array.from(response.body)])),
          completedAt: new Date(Math.max(now(), Date.parse(startedAt))).toISOString() });
      } catch {
        return CampaignCreationProviderResult.parse({ ...base, completedAt: new Date(Math.max(now(), Date.parse(startedAt))).toISOString() });
      }
    },
    async observe(raw, nodeId, signal) {
      const batch = CampaignCreationBatch.parse(raw);
      const call = prepare(batch, nodeId);
      const row = batch.nodes.find((node) => node.nodeId === nodeId)!;
      if ((row.intent && row.intent.requestDigest !== call.requestDigest) || (!row.intent && !batch.lineage)) throw new Error('Creation observation authority unavailable');
      return discoverSpCreation(call, row.result?.outcome === 'succeeded' ? row.result.providerEntityId : null, {
        now, hasher, read: (path, body, timeoutMs) => httpRequestOnce(ctx, {
          method: 'POST', url: `${hostFor(call.providerScope.region)}${path}`, body, headers: headers(call),
          timeoutMs, signal, redirect: 'error', maxResponseBytes: 1_048_576,
        }),
      });
    },
  };
}
