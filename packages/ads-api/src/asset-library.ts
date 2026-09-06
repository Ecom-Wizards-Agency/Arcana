/**
 * Worker-only Asset Library transport. Import through the explicit subpath.
 * Source: WP-215-AMAZON-CAPABILITIES-2026-09-06.md S6 (fd717191…a520).
 * Construction is inert. This client supplies no approval, persistence or binary upload.
 */
import {
  AssetLibraryIdentity, AssetLibraryObservation, AssetLibraryProgramSpecifications,
  AssetLibraryRegistration, AssetLibraryRegistrationOutcome, AssetLibraryScope,
  AssetLibrarySearchRequest, AssetLibrarySearchResult,
  type AssetLibraryProcessing, type AssetLibrarySpecChecks,
} from '@wizard-ads/shared/asset-library';
import { TokenProvider } from './auth.js';
import { createHttpContext } from './context.js';
import { adsHeaders } from './headers.js';
import { decodeText, HttpAttemptError, httpRequest, httpRequestOnce, type HttpResult } from './http.js';
import { isRecord } from './read.js';
import { hostFor } from './regions.js';
import type { AdsApiClientOptions } from './types.js';

export interface AssetLibraryCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface AssetLibrarySearchOptions extends AssetLibraryCallOptions {
  /** A resource bound, not truncation: reaching it fails the complete search. */
  maxPages?: number;
}

/** Sensitive temporary transport state: never persist, log or return through a UI/API loader. */
export interface AssetLibraryUploadLocation { url: string }

export interface AssetLibraryClient {
  search(input?: Partial<AssetLibrarySearchRequest>, options?: AssetLibrarySearchOptions): Promise<AssetLibrarySearchResult>;
  get(identity: AssetLibraryIdentity, options?: AssetLibraryCallOptions): Promise<AssetLibraryObservation>;
  prepareUploadLocation(fileName: string, options?: AssetLibraryCallOptions): Promise<AssetLibraryUploadLocation>;
  /** The caller must authorize and durably record intent before this single provider attempt. */
  register(input: AssetLibraryRegistration, transport: AssetLibraryUploadLocation,
    options?: AssetLibraryCallOptions): Promise<AssetLibraryRegistrationOutcome>;
}

/** Contains neither provider text nor nested causes that could leak upload URLs or credentials. */
export class AssetLibraryError extends Error {
  override readonly name = 'AssetLibraryError';
  constructor(readonly code: 'invalid_configuration' | 'read_failed' | 'upload_location_failed') {
    super(`Asset Library ${code}`);
  }
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MEDIA = {
  get: 'application/vnd.creativeassetsgetresponse.v3+json',
  search: 'application/vnd.creativeassetssearchassetsresponse.v3+json',
  upload: 'application/vnd.creativeassetsuploadresponse.v3+json',
  register: 'application/vnd.creativeassetsregisterresponse.v3+json',
} as const;

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('invalid object');
  return value;
}

function string(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('invalid string');
  return value;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('invalid array');
  return value;
}

function json(result: HttpResult): Record<string, unknown> {
  if (result.status !== 200) throw new Error('unexpected response');
  return record(JSON.parse(decodeText(result.body)) as unknown);
}

function processing(value: unknown): AssetLibraryProcessing {
  if (value === undefined || value === null) return 'unknown';
  switch (string(value)) {
    case 'ACTIVE': return 'active';
    case 'PROCESSING': return 'processing';
    case 'ARCHIVED': return 'archived';
    // Explicitly documented by the asset-creation guide, absent from S6's enum.
    case 'INACTIVE': return 'inactive';
    default: return 'unknown';
  }
}

function failedSpecChecks(value: unknown): AssetLibrarySpecChecks['failedSpecChecks'] {
  if (value === undefined) return null;
  return array(value).map((item) => {
    const group = record(item);
    return AssetLibraryProgramSpecifications.parse({
      program: group['specProgramName'],
      specifications: array(group['specifications']).map((specification) => {
        const spec = record(specification);
        return { stringId: spec['stringId'] ?? null, passed: spec['isPassed'] };
      }),
    });
  });
}

function observation(scope: AssetLibraryScope, identity: AssetLibraryIdentity,
  assetType: unknown, item: Record<string, unknown>, status: unknown, observedAt: string): AssetLibraryObservation {
  return AssetLibraryObservation.parse({
    scope, identity, observedAt,
    assetType: assetType === 'IMAGE' ? 'image' : assetType === 'VIDEO' ? 'video' : 'unknown',
    name: item['name'] ?? null,
    processing: processing(status),
    specChecks: {
      approvedPrograms: item['specCheckApprovedPrograms'] ?? null,
      failedSpecChecks: failedSpecChecks(item['failedSpecChecks']),
    },
  });
}

function callOptions(options: AssetLibraryCallOptions) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new Error('invalid timeout');
  }
  return {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    timeoutMs, maxResponseBytes: MAX_RESPONSE_BYTES, redirect: 'error' as const,
  };
}

function transportUrl(transport: AssetLibraryUploadLocation): string {
  const url = new URL(transport.url);
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new Error('invalid upload transport');
  }
  // Host trust for a subsequent binary PUT is a separate worker policy. This
  // client never fetches this URL and never forwards Amazon authorization to it.
  return transport.url;
}

export function createAssetLibraryClient(options: AdsApiClientOptions,
  requestedScope: AssetLibraryScope): AssetLibraryClient {
  const parsedScope = AssetLibraryScope.safeParse(requestedScope);
  if (!parsedScope.success || parsedScope.data.region !== options.region) {
    throw new AssetLibraryError('invalid_configuration');
  }
  const scope = Object.freeze(parsedScope.data);
  const ctx = createHttpContext(options.region, options);
  const tokens = new TokenProvider(options.credentials, options);
  const host = hostFor(scope.region);
  const headers = (accept: string) => adsHeaders(
    (force, signal) => force ? tokens.forceRefresh(signal) : tokens.getAccessToken(signal),
    { clientId: options.credentials.clientId, profileId: scope.amazonProfileId,
      contentType: 'application/json', accept,
      ...(options.userAgent === undefined ? {} : { userAgent: options.userAgent }) },
  );

  return {
    async search(input = {}, options = {}) {
      try {
        const request = AssetLibrarySearchRequest.parse(input);
        const attemptOptions = callOptions(options);
        const maxPages = options.maxPages ?? 1000;
        if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw new Error('invalid page bound');
        const assets: AssetLibraryObservation[] = [];
        const seenIdentities = new Set<string>();
        const seenTokens = new Set<string>();
        let totalRecords: number | null = null;
        let token: string | null = null;
        for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
          const { pageSize, ...criteria } = request;
          const result = await httpRequest(ctx, {
            method: 'POST', url: `${host}/assets/search`, path: '/assets/search',
            headers: headers(MEDIA.search), idempotent: true, ...attemptOptions,
            body: JSON.stringify({ ...criteria, pageCriteria: { size: pageSize,
              ...(token === null ? {} : { identifier: { pageNumber, token } }) } }),
          });
          const body = json(result);
          const total = body['totalRecords'];
          if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0
            || (totalRecords !== null && totalRecords !== total)) throw new Error('invalid total');
          totalRecords = total;
          const page = array(body['assetList']);
          if (page.length > pageSize) throw new Error('page exceeds requested size');
          const observedAt = new Date(ctx.now()).toISOString();
          for (const value of page) {
            const item = record(value);
            const identity = AssetLibraryIdentity.parse({ assetId: item['assetId'], version: item['version'] });
            const key = JSON.stringify(identity);
            if (seenIdentities.has(key)) throw new Error('duplicate asset version');
            seenIdentities.add(key);
            assets.push(observation(scope, identity, item['assetType'], item, item['status'], observedAt));
          }
          if (assets.length > total) throw new Error('too many rows');
          token = body['token'] === undefined || body['token'] === null || body['token'] === ''
            ? null : string(body['token']);
          if (token === null) {
            return AssetLibrarySearchResult.parse({ scope, assets,
              counts: { pages: pageNumber + 1, providerRows: assets.length,
                returnedRows: assets.length, totalRecords: total } });
          }
          if (page.length === 0 || assets.length >= total || seenTokens.has(token)) {
            throw new Error('inconsistent pagination');
          }
          seenTokens.add(token);
        }
        throw new Error('page bound exhausted');
      } catch { throw new AssetLibraryError('read_failed'); }
    },

    async get(input, options = {}) {
      try {
        const identity = AssetLibraryIdentity.parse(input);
        const query = new URLSearchParams({ assetId: identity.assetId, version: identity.version });
        const body = json(await httpRequest(ctx, {
          method: 'GET', url: `${host}/assets?${query}`, path: '/assets',
          headers: headers(MEDIA.get), idempotent: true, ...callOptions(options),
        }));
        const global = record(body['assetGlobal']);
        if (global['assetId'] !== identity.assetId) throw new Error('wrong asset');
        const versions = array(body['assetVersionList']);
        if (versions.length !== 1) throw new Error('ambiguous asset version');
        const version = record(versions[0]);
        const returnedIdentity = AssetLibraryIdentity.parse(version['assetIdentifier']);
        if (returnedIdentity.assetId !== identity.assetId || returnedIdentity.version !== identity.version) {
          throw new Error('wrong asset version');
        }
        return observation(scope, returnedIdentity, global['assetType'], version,
          version['assetStatus'], new Date(ctx.now()).toISOString());
      } catch { throw new AssetLibraryError('read_failed'); }
    },

    async prepareUploadLocation(fileName, options = {}) {
      try {
        if (typeof fileName !== 'string' || !/^[^/\\]+\.[A-Za-z0-9]+$/.test(fileName)
          || [...fileName].some((character) => character.charCodeAt(0) < 32)) {
          throw new Error('invalid file name');
        }
        const body = json(await httpRequestOnce(ctx, {
          method: 'POST', url: `${host}/assets/upload`, headers: headers(MEDIA.upload),
          body: JSON.stringify({ fileName }), ...callOptions(options),
        }));
        const location = { url: string(body['url']) };
        transportUrl(location);
        return location;
      } catch { throw new AssetLibraryError('upload_location_failed'); }
    },

    async register(input, transport, options = {}) {
      let registration: AssetLibraryRegistration;
      let requestBody: string;
      let attemptOptions: ReturnType<typeof callOptions>;
      try {
        registration = AssetLibraryRegistration.parse(input);
        const url = transportUrl(transport);
        attemptOptions = callOptions(options);
        requestBody = JSON.stringify({ url, name: registration.name,
          assetType: registration.assetType, assetSubTypeList: registration.assetSubTypes,
          ...(registration.asins === undefined ? {} : { asinList: registration.asins }),
          ...(registration.tags === undefined ? {} : { tags: registration.tags }),
          ...(registration.linkedVersion === undefined ? {} : { versionInfo: {
            linkedAssetId: registration.linkedVersion.assetId,
            ...(registration.linkedVersion.notes === undefined ? {} : { versionNotes: registration.linkedVersion.notes }),
          } }),
          ...(registration.brandEntityIds === undefined ? {} : { associatedSubEntityList:
            registration.brandEntityIds.map((brandEntityId) => ({ brandEntityId })) }),
          ...(registration.skipSubtypeDetection === undefined ? {} : {
            skipAssetSubTypesDetection: registration.skipSubtypeDetection,
          }),
        });
      } catch { return { kind: 'not_attempted', scope, reason: 'invalid_input' }; }

      let result: HttpResult;
      try {
        result = await httpRequestOnce(ctx, {
          method: 'POST', url: `${host}/assets/register`, headers: headers(MEDIA.register),
          body: requestBody, ...attemptOptions,
        });
      } catch (error) {
        if (error instanceof HttpAttemptError && error.phase === 'headers') {
          return { kind: 'not_attempted', scope, reason: 'headers_failed' };
        }
        return { kind: 'uncertain', scope,
          reason: error instanceof HttpAttemptError && error.phase === 'body' ? 'body_failed' : 'transport_failed' };
      }
      if (result.status === 400 || result.status === 401 || result.status === 403
        || result.status === 404 || result.status === 429) {
        return { kind: 'refused', scope, status: result.status };
      }
      if (result.status !== 200) return { kind: 'uncertain', scope, reason: 'unexpected_status' };
      try {
        const body = json(result);
        const identity = AssetLibraryIdentity.parse({ assetId: body['assetId'], version: body['versionId'] });
        if (registration.linkedVersion !== undefined && identity.assetId !== registration.linkedVersion.assetId) {
          throw new Error('wrong linked asset');
        }
        return AssetLibraryRegistrationOutcome.parse({ kind: 'accepted', scope, identity,
          failedSpecChecks: failedSpecChecks(body['failedSpecChecks']) });
      } catch { return { kind: 'uncertain', scope, reason: 'invalid_response' }; }
    },
  };
}
