import { describe, expect, it, vi } from 'vitest';
import * as rootApi from './index.js';
import { createAssetLibraryClient, AssetLibraryError } from './asset-library.js';
import type { AssetLibraryRegistration } from '@wizard-ads/shared/asset-library';
import type { FetchLike } from './types.js';

const scope = { region: 'EU', amazonProfileId: '1000000001' } as const;
const credentials = { clientId: 'synthetic-client',
  clientSecret: ['synthetic', 'secret'].join('-'), refreshToken: ['synthetic', 'refresh'].join('-') };
const identity = { assetId: 'synthetic-video', version: 'version_2' };
const location = { url: 'https://example.invalid/temporary-upload?signature=synthetic-sensitive-value' };
const registration: AssetLibraryRegistration = {
  name: 'Synthetic video', assetType: 'VIDEO', assetSubTypes: ['BACKGROUND_VIDEO'],
  brandEntityIds: ['synthetic-brand'], linkedVersion: { assetId: identity.assetId, notes: 'Synthetic revision' },
};
const approvedPrograms = ['SPONSORED_BRANDS_VIDEO'];
const specFailures = [{ specProgramName: 'SPONSORED_DISPLAY_VIDEO', specifications: [
  { stringId: 'duration', isPassed: false, failureReason: location.url, arguments: [location.url] },
] }];

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function searchAsset(assetId = identity.assetId, version = identity.version) {
  return { assetId, version, assetType: 'VIDEO', name: 'Synthetic video', status: 'ACTIVE',
    specCheckApprovedPrograms: approvedPrograms, url: location.url, storageLocationUrls: [location.url] };
}

function exactAsset() {
  return { assetGlobal: { assetId: identity.assetId, assetType: 'VIDEO' }, assetVersionList: [{
    assetIdentifier: identity, name: 'Synthetic video', assetStatus: 'PROCESSING',
    specCheckApprovedPrograms: approvedPrograms, failedSpecChecks: specFailures, url: location.url,
  }] };
}

function setup(provider: FetchLike) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  let tokenCalls = 0;
  const fetch: FetchLike = async (url, init) => {
    if (url === 'https://api.amazon.com/auth/o2/token') {
      tokenCalls += 1;
      return response({ access_token: ['synthetic', 'access'].join('-'), expires_in: 3600, token_type: 'bearer' });
    }
    calls.push({ url, init });
    return provider(url, init);
  };
  const client = createAssetLibraryClient({ region: 'EU',
    credentials,
    fetch, sleep: async () => undefined, now: () => Date.parse('2026-09-06T12:00:00.000Z'),
    retry: { maxAttempts: 3, jitter: 0 },
  }, scope);
  return { client, calls, tokenCalls: () => tokenCalls };
}

describe('Asset Library client', () => {
  it('is inert at construction and absent from the default package export', () => {
    const run = setup(async () => { throw new Error('construction must be inert'); });
    expect(run.calls).toEqual([]);
    expect(run.tokenCalls()).toBe(0);
    expect('createAssetLibraryClient' in rootApi).toBe(false);
    const fetch = vi.fn<FetchLike>();
    expect(() => createAssetLibraryClient({ region: 'NA', fetch,
      credentials: { clientId: '', clientSecret: '', refreshToken: '' } }, scope))
      .toThrow(new AssetLibraryError('invalid_configuration'));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reads only the exact asset/version through the exact regional profile header', async () => {
    const run = setup(async () => response(exactAsset()));
    const result = await run.client.get(identity);
    expect(run.calls).toHaveLength(1);
    const call = run.calls[0]!;
    expect(call.url).toBe('https://advertising-api-eu.amazon.com/assets?assetId=synthetic-video&version=version_2');
    expect(call.init?.headers).toMatchObject({
      'Amazon-Advertising-API-Scope': scope.amazonProfileId,
      'Amazon-Advertising-API-ClientId': 'synthetic-client',
      Accept: 'application/vnd.creativeassetsgetresponse.v3+json',
    });
    expect(call.init?.redirect).toBe('error');
    expect(result).toEqual({ scope, identity, observedAt: '2026-09-06T12:00:00.000Z',
      assetType: 'video', name: 'Synthetic video', processing: 'processing',
      specChecks: { approvedPrograms, failedSpecChecks: [{ program: 'SPONSORED_DISPLAY_VIDEO',
        specifications: [{ stringId: 'duration', passed: false }] }] } });
    expect(JSON.stringify(result)).not.toContain(location.url);
    expect(result).not.toHaveProperty('moderation');
  });

  it.each(['wrong_global', 'wrong_id', 'wrong_version', 'extra_version', 'empty_versions', 'numeric_id', 'bad_specs'])(
    'refuses a malformed or unmatched exact read: %s', async (mode) => {
    const body = exactAsset();
    switch (mode) {
      case 'wrong_global': body.assetGlobal.assetId = 'other-asset'; break;
      case 'wrong_id': body.assetVersionList[0]!.assetIdentifier = { ...identity, assetId: 'other-asset' }; break;
      case 'wrong_version': body.assetVersionList[0]!.assetIdentifier = { ...identity, version: 'version_3' }; break;
      case 'extra_version': body.assetVersionList.push(body.assetVersionList[0]!); break;
      case 'empty_versions': body.assetVersionList = []; break;
      case 'numeric_id': Object.assign(body.assetGlobal, { assetId: 1000000001 }); break;
      case 'bad_specs': Object.assign(body.assetVersionList[0]!, { failedSpecChecks: [{}] }); break;
    }
    const run = setup(async () => response(body));
    await expect(run.client.get(identity)).rejects.toEqual(new AssetLibraryError('read_failed'));
    expect(run.calls).toHaveLength(1);
  });

  it.each([['INACTIVE', 'inactive'], ['ARCHIVED', 'archived'], ['FUTURE_STATUS', 'unknown']] as const)(
    'retains processing %s independently of specification approval', async (providerStatus, expected) => {
    const body = exactAsset();
    body.assetVersionList[0]!.assetStatus = providerStatus;
    const result = await setup(async () => response(body)).client.get(identity);
    expect(result.processing).toBe(expected);
    expect(result.specChecks.approvedPrograms).toEqual(approvedPrograms);
  });

  it('searches every page with unchanged filters and reconciles exact ID/version counts', async () => {
    const run = setup(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { pageCriteria: { identifier?: unknown } };
      return response(body.pageCriteria.identifier === undefined
        ? { assetList: [searchAsset()], totalRecords: 2, token: 'next-page' }
        : { assetList: [searchAsset('second-asset', 'version_1')], totalRecords: 2 });
    });
    const request = { text: 'Synthetic', pageSize: 1,
      sortCriteria: { field: 'NAME', order: 'ASC' } as const,
      filterCriteria: { valueFilters: [{ valueField: 'ASSET_TYPE' as const, values: ['VIDEO'] }],
        rangeFilters: [{ rangeField: 'SIZE' as const, ranges: [{ start: '10', end: '20' }] }] } };
    const result = await run.client.search(request);
    expect(result.counts).toEqual({ pages: 2, providerRows: 2, returnedRows: 2, totalRecords: 2 });
    expect(result.assets.map((asset) => asset.identity)).toEqual([identity, { assetId: 'second-asset', version: 'version_1' }]);
    expect(run.calls).toHaveLength(2);
    for (const [index, call] of run.calls.entries()) {
      expect(call.url).toBe('https://advertising-api-eu.amazon.com/assets/search');
      expect(call.init?.headers).toMatchObject({ 'Amazon-Advertising-API-Scope': scope.amazonProfileId,
        Accept: 'application/vnd.creativeassetssearchassetsresponse.v3+json' });
      expect(JSON.parse(String(call.init?.body))).toEqual({ text: request.text,
        sortCriteria: request.sortCriteria, filterCriteria: request.filterCriteria,
        pageCriteria: { size: 1, ...(index === 0 ? {} : { identifier: { pageNumber: 1, token: 'next-page' } }) } });
    }
    expect(JSON.stringify(result)).not.toContain(location.url);
  });

  it.each(['missing_total', 'missing_version', 'malformed_row', 'short_total', 'changing_total',
    'duplicate', 'repeat_token', 'empty_continuation', 'token_at_total', 'page_size_exceeded', 'page_bound'])(
    'does not return a partially accounted search: %s', async (mode) => {
    let page = 0;
    const run = setup(async () => {
      page += 1;
      if (mode === 'missing_total') return response({ assetList: [searchAsset()] });
      if (mode === 'missing_version') return response({ assetList: [{ ...searchAsset(), version: undefined }], totalRecords: 1 });
      if (mode === 'malformed_row') return response({ assetList: [searchAsset(), null], totalRecords: 2 });
      if (mode === 'short_total') return response({ assetList: [searchAsset()], totalRecords: 2 });
      if (mode === 'empty_continuation') return response({ assetList: [], totalRecords: 2, token: 'next' });
      if (mode === 'token_at_total') return response({ assetList: [searchAsset()], totalRecords: 1, token: 'next' });
      if (mode === 'page_size_exceeded') return response({ assetList: [searchAsset(), searchAsset('other')], totalRecords: 2 });
      return response({ assetList: [searchAsset(mode === 'duplicate' ? identity.assetId : `asset-${page}`)],
        totalRecords: mode === 'changing_total' ? page + 2 : 3, token: 'next' });
    });
    await expect(run.client.search({ pageSize: mode === 'page_size_exceeded' ? 1 : 100 },
      mode === 'page_bound' ? { maxPages: 1 } : {})).rejects.toEqual(new AssetLibraryError('read_failed'));
    expect(run.calls.length).toBeLessThanOrEqual(2);
  });

  it('counts an empty complete search explicitly', async () => {
    const run = setup(async () => response({ assetList: [], totalRecords: 0 }));
    expect(await run.client.search()).toEqual({ scope, assets: [],
      counts: { pages: 1, providerRows: 0, returnedRows: 0, totalRecords: 0 } });
  });

  it('requests the pinned fileName spelling and returns only temporary transport state', async () => {
    const run = setup(async () => response(location));
    expect(await run.client.prepareUploadLocation('synthetic-video.mp4')).toEqual(location);
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]!.url).toBe('https://advertising-api-eu.amazon.com/assets/upload');
    expect(JSON.parse(String(run.calls[0]!.init?.body))).toEqual({ fileName: 'synthetic-video.mp4' });
    expect(run.calls[0]!.init?.headers).toMatchObject({ 'Amazon-Advertising-API-Scope': scope.amazonProfileId,
      Accept: 'application/vnd.creativeassetsuploadresponse.v3+json' });
  });

  it.each([401, 429, 500])('does not retry upload-location HTTP %s', async (status) => {
    const run = setup(async () => response({ error: location.url }, status));
    await expect(run.client.prepareUploadLocation('synthetic-video.mp4'))
      .rejects.toEqual(new AssetLibraryError('upload_location_failed'));
    expect(run.calls).toHaveLength(1);
    expect(run.tokenCalls()).toBe(1);
  });

  it.each(['http://example.invalid/media', 'https://user:password@example.invalid/media',
    'https://example.invalid/media#fragment'])('refuses an invalid returned upload URL', async (url) => {
    const run = setup(async () => response({ url }));
    await expect(run.client.prepareUploadLocation('synthetic-video.mp4'))
      .rejects.toEqual(new AssetLibraryError('upload_location_failed'));
  });

  it('registers once and records spec failures without URLs, prose or invented processing', async () => {
    const run = setup(async () => response({ assetId: identity.assetId,
      versionId: identity.version, failedSpecChecks: specFailures, url: location.url }));
    const result = await run.client.register(registration, location);
    expect(result).toEqual({ kind: 'accepted', scope, identity,
      failedSpecChecks: [{ program: 'SPONSORED_DISPLAY_VIDEO', specifications: [{ stringId: 'duration', passed: false }] }] });
    expect(JSON.stringify(result)).not.toContain(location.url);
    expect(result).not.toHaveProperty('processing');
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]!.init?.headers).toMatchObject({ 'Amazon-Advertising-API-Scope': scope.amazonProfileId,
      Accept: 'application/vnd.creativeassetsregisterresponse.v3+json' });
    expect(JSON.parse(String(run.calls[0]!.init?.body))).toEqual({
      url: location.url, name: registration.name, assetType: 'VIDEO', assetSubTypeList: ['BACKGROUND_VIDEO'],
      associatedSubEntityList: [{ brandEntityId: 'synthetic-brand' }],
      versionInfo: { linkedAssetId: identity.assetId, versionNotes: 'Synthetic revision' },
    });
  });

  it('leaves absent registration specification evidence unknown', async () => {
    const run = setup(async () => response({ assetId: identity.assetId, versionId: identity.version }));
    expect(await run.client.register(registration, location)).toEqual({ kind: 'accepted', scope, identity,
      failedSpecChecks: null });
  });

  it.each([400, 401, 403, 404, 429])('preserves definite registration HTTP %s without refresh or retry', async (status) => {
    const run = setup(async () => response({ message: location.url }, status));
    expect(await run.client.register(registration, location)).toEqual({ kind: 'refused', scope, status });
    expect(run.calls).toHaveLength(1);
    expect(run.tokenCalls()).toBe(1);
  });

  it.each(['fetch', 'body', 'json', 'wrong_asset', 'missing_version', 'bad_specs', '500', '409'])(
    'retains uncertainty after registration failure: %s', async (mode) => {
    const run = setup(async () => {
      if (mode === 'fetch') throw new Error(location.url);
      if (mode === 'body') return new Response(new ReadableStream({
        start(controller) { controller.error(new Error(location.url)); },
      }));
      if (mode === 'json') return new Response(location.url);
      if (mode === '500' || mode === '409') return response({ message: location.url }, Number(mode));
      return response({ assetId: mode === 'wrong_asset' ? 'other-asset' : identity.assetId,
        ...(mode === 'missing_version' ? {} : { versionId: identity.version }),
        ...(mode === 'bad_specs' ? { failedSpecChecks: [{}] } : {}) });
    });
    const result = await run.client.register(registration, location);
    expect(result).toEqual({ kind: 'uncertain', scope,
      reason: mode === 'fetch' ? 'transport_failed' : mode === 'body' ? 'body_failed'
        : mode === '500' || mode === '409' ? 'unexpected_status' : 'invalid_response' });
    expect(run.calls).toHaveLength(1);
    expect(run.tokenCalls()).toBe(1);
    expect(JSON.stringify(result)).not.toContain(location.url);
  });

  it('distinguishes a header failure from an attempted registration without leaking its cause', async () => {
    const fetch = vi.fn<FetchLike>(async () => { throw new Error(location.url); });
    const client = createAssetLibraryClient({ region: 'EU', fetch, sleep: async () => undefined,
      retry: { maxAttempts: 1 }, credentials }, scope);
    expect(await client.register(registration, location)).toEqual({ kind: 'not_attempted', scope, reason: 'headers_failed' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe('https://api.amazon.com/auth/o2/token');
  });

  it('refuses invalid metadata or transport before even resolving credentials', async () => {
    const run = setup(async () => { throw new Error('must not call'); });
    for (const [input, transport] of [[{ ...registration, assetSubTypes: ['LOGO'] }, location],
      [registration, { url: 'http://example.invalid/media' }]] as const) {
      expect(await run.client.register(input as AssetLibraryRegistration, transport))
        .toEqual({ kind: 'not_attempted', scope, reason: 'invalid_input' });
    }
    expect(await run.client.register(registration, location, { timeoutMs: 0 }))
      .toEqual({ kind: 'not_attempted', scope, reason: 'invalid_input' });
    expect(run.calls).toHaveLength(0);
    expect(run.tokenCalls()).toBe(0);
  });

  it('cancels a stalled registration body and leaves the single attempt uncertain', async () => {
    const cancel = vi.fn();
    const run = setup(async () => new Response(new ReadableStream<Uint8Array>({ cancel })));
    expect(await run.client.register(registration, location, { timeoutMs: 20 }))
      .toEqual({ kind: 'uncertain', scope, reason: 'body_failed' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(run.calls).toHaveLength(1);
  });

  it('cancels an oversized response without returning or storing its body', async () => {
    const cancel = vi.fn();
    const run = setup(async () => new Response(new ReadableStream<Uint8Array>({ cancel }), {
      headers: { 'content-length': String(2 * 1024 * 1024 + 1) },
    }));
    expect(await run.client.register(registration, location)).toEqual({ kind: 'uncertain', scope, reason: 'body_failed' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(run.calls).toHaveLength(1);
  });

  it('treats prior cancellation as not attempted and sanitizes read failures', async () => {
    const run = setup(async () => { throw new Error(location.url); });
    const controller = new AbortController();
    controller.abort(new Error(location.url));
    expect(await run.client.register(registration, location, { signal: controller.signal }))
      .toEqual({ kind: 'not_attempted', scope, reason: 'headers_failed' });
    expect(run.tokenCalls()).toBe(0);
    let error: unknown;
    try { await run.client.get(identity); } catch (cause) { error = cause; }
    expect(error).toEqual(new AssetLibraryError('read_failed'));
    expect(error).not.toHaveProperty('cause');
    expect(String(error)).not.toContain(location.url);
  });
});
