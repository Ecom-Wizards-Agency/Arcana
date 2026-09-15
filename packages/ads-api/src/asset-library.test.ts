import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AssetLibraryClient, type AssetLibraryClientOptions } from './asset-library.js';

const scope = { region: 'EU', amazonProfileId: '1000000001' } as const;
const bytes = Uint8Array.from([137,80,78,71,13,10,26,10]);
const manifest = { fileName: 'synthetic.png', contentType: 'image/png', byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } as const;
const registration = { name: 'Synthetic asset', assetType: 'IMAGE', assetSubTypes: ['PRODUCT_IMAGE'] } as const;
const imageRegistration = () => ({ ...registration, assetSubTypes: [...registration.assetSubTypes] });
const origin = 'https://storage.example.invalid';
const asset = (assetId: string, version = 'v1') => ({ assetId, version, assetType: 'IMAGE', name: 'Synthetic', status: 'ACTIVE',
  fileMetadata: { fileSize: 8, width: 100, height: 100, contentType: 'image/png' },
  storageLocationUrls: { defaultUrl: `${origin}/temporary` } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function harness(replies: Array<Response | Error>, overrides: Partial<AssetLibraryClientOptions> = {}) {
  const fetch = vi.fn(async () => { const response = replies.shift(); if (response instanceof Error) throw response; if (!response) throw new Error('Unexpected provider call'); return response; });
  const client = new AssetLibraryClient({ scope, fetch, headers: async () => ({ 'Amazon-Advertising-API-Scope': scope.amazonProfileId }),
    now: () => Date.parse('2026-09-15T12:00:00Z'), uploadOrigins: [origin], ...overrides });
  return { client, fetch };
}
async function uploaded(client: AssetLibraryClient) {
  const result = await client.upload(manifest, bytes);
  if (result.kind !== 'uploaded') throw new Error('Expected uploaded fixture');
  return result.content;
}
function uploadReplies(suffix = 'one') { return [json({ url: `${origin}/${suffix}` }), new Response(null, { status: 200 })]; }

describe('Asset Library v3 fake transport', () => {
  it('counts every page and removes temporary URLs before returning observations', async () => {
    const { client, fetch } = harness([json({ assetList: [asset('asset-a')], totalRecords: 2, token: 'next' }), json({ assetList: [asset('asset-b')], totalRecords: 2 })]);
    const result = await client.search({ pageSize: 1, text: 'Synthetic' });
    expect(result.counts).toEqual({ pages: 2, providerRows: 2, returnedRows: 2, totalRecords: 2 });
    expect(JSON.stringify(result)).not.toContain('temporary');
    expect(result.assets[0]?.mediaMetadata?.byteLength).toBe(8);
    const calls = fetch.mock.calls as unknown as [string, RequestInit][];
    expect(JSON.parse(String(calls[1]?.[1].body))).toEqual({ text: 'Synthetic', pageCriteria: { size: 1, identifier: { pageNumber: 1, token: 'next' } } });
  });
  it.each(['duplicate', 'changed_total', 'missing_version', 'loop', 'partial'])('refuses %s search without claiming completeness', async (problem) => {
    const first = { assetList: [asset('asset-a')], totalRecords: 2, token: 'next' };
    const last = problem === 'duplicate' ? { assetList: [asset('asset-a')], totalRecords: 2 }
      : problem === 'changed_total' ? { assetList: [asset('asset-b')], totalRecords: 3 }
      : problem === 'missing_version' ? { assetList: [{ ...asset('asset-b'), version: undefined }], totalRecords: 2 }
      : problem === 'loop' ? { assetList: [asset('asset-b')], totalRecords: 2, token: 'next' }
      : { assetList: [], totalRecords: 2 };
    const { client } = harness([json(first), json(last)]);
    await expect(client.search({ pageSize: 1 })).rejects.toThrow();
  });
  it('verifies the exact asset and version in lookup', async () => {
    const raw = { assetGlobal: { assetId: 'asset-a', assetType: 'IMAGE' }, assetVersionList: [
      { assetIdentifier: { assetId: 'asset-a', version: 'v1' }, assetStatus: 'PROCESSING', name: 'Synthetic' }] };
    const { client } = harness([json(raw), json(raw)]);
    expect((await client.lookup({ assetId: 'asset-a', version: 'v1' })).processing).toBe('processing');
    await expect(client.lookup({ assetId: 'asset-a', version: 'v2' })).rejects.toThrow('version mismatch');
  });
  it('binds every authenticated request to the configured profile', async () => {
    const { client, fetch } = harness([], { headers: async () => ({ 'Amazon-Advertising-API-Scope': '1000000002' }) });
    await expect(client.search({ pageSize: 10 })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['checksum', 'size', 'type', 'signature', 'name'])('rejects bad %s before any provider attempt', async (problem) => {
    const invalid = problem === 'checksum' ? { ...manifest, sha256: '0'.repeat(64) }
      : problem === 'size' ? { ...manifest, byteLength: 3 }
      : problem === 'type' ? { ...manifest, contentType: 'video/mp4' as const }
      : problem === 'name' ? { ...manifest, fileName: '../synthetic.png' } : manifest;
    const body = problem === 'signature' ? Uint8Array.from(bytes, () => 0) : bytes;
    const { client, fetch } = harness([]);
    expect((await client.upload(invalid, body)).kind).toBe('not_attempted'); expect(fetch).not.toHaveBeenCalled();
  });
  it('defaults upload origin permission off', async () => {
    const { client, fetch } = harness([], { uploadOrigins: [] });
    expect(await client.upload(manifest, bytes)).toEqual({ kind: 'not_attempted', reason: 'upload_origin_not_allowed' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('refuses arbitrary upload destinations and never follows redirects', async () => {
    const { client, fetch } = harness([json({ url: 'https://unreviewed.example.invalid/upload' })]);
    expect((await client.upload(manifest, bytes)).kind).toBe('not_attempted'); expect(fetch).toHaveBeenCalledTimes(1);
    const { client: other, fetch: calls } = harness(uploadReplies()); await uploaded(other);
    const requests = calls.mock.calls as unknown as [string, RequestInit][];
    expect(requests[1]?.[1].redirect).toBe('error');
    expect(new Headers(requests[1]?.[1].headers).has('Amazon-Advertising-API-Scope')).toBe(false);
  });
  it('registers immutable provider version and separates specification acceptance', async () => {
    const { client, fetch } = harness([...uploadReplies(), json({ assetId: 'asset-a', versionId: 'provider-version',
      failedSpecChecks: [{ specProgramName: 'SPONSORED_BRANDS_VIDEO', specifications: [{ stringId: 'duration', isPassed: false }] }] })]);
    const content = await uploaded(client); const result = await client.register(content, imageRegistration());
    expect(result).toMatchObject({ kind: 'accepted', identity: { assetId: 'asset-a', version: 'provider-version' }, failedSpecChecks: [{ specifications: [{ passed: false }] }] });
    expect(JSON.stringify(content)).not.toContain(origin);
    expect(await client.register(content, imageRegistration())).toEqual(result);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it.each([new Error('network failure'), json({}, 500), json({ assetId: 'asset-a' })])('never blindly retries ambiguous registration', async (response) => {
    const { client, fetch } = harness([...uploadReplies(), response]); const content = await uploaded(client);
    const result = await client.register(content, imageRegistration()); expect(result.kind).toBe('uncertain');
    expect(await client.register(content, imageRegistration())).toEqual(result); expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('refuses a handle from another authenticated owner', async () => {
    const { client } = harness(uploadReplies()); const content = await uploaded(client);
    const { client: other, fetch } = harness([]);
    expect((await other.register(content, imageRegistration())).kind).toBe('not_attempted'); expect(fetch).not.toHaveBeenCalled();
  });
  it('counts asynchronous partial batch outcomes and retains URL-to-input correspondence transiently', async () => {
    const { client } = harness([...uploadReplies('one'), ...uploadReplies('two'), json({ requestId: 'batch-one' }),
      json({ registrationStatus: 'COMPLETE', successfullyRegisteredAssets: [{ url: `${origin}/one`, assetIdentifier: { assetId: 'asset-a', version: 'v1' } }],
        inProgressAssetDetails: [], failedAssetDetails: [{ url: `${origin}/two`, failureReason: 'private provider material' }] })]);
    const first = await uploaded(client); const second = await uploaded(client);
    expect(await client.startBatch([{ content: first, registration: imageRegistration() }, { content: second, registration: imageRegistration() }])).toEqual({ kind: 'accepted', requestId: 'batch-one', submitted: 2 });
    const result = await client.batchStatus('batch-one');
    expect(result.counts).toEqual({ submitted: 2, accepted: 1, processing: 0, refused: 1 });
    expect(result.items.map((item) => item.index)).toEqual([0, 1]);
    expect(JSON.stringify(result)).not.toContain(origin); expect(JSON.stringify(result)).not.toContain('private');
  });
  it('refuses unmatched batch outcome counts and unowned batch IDs', async () => {
    const { client, fetch } = harness([...uploadReplies(), json({ requestId: 'batch-one' }), json({ registrationStatus: 'COMPLETE', successfullyRegisteredAssets: [], inProgressAssetDetails: [], failedAssetDetails: [] })]);
    await expect(client.batchStatus('unowned')).rejects.toThrow('ownership'); expect(fetch).not.toHaveBeenCalled();
    const content = await uploaded(client); await client.startBatch([{ content, registration: imageRegistration() }]);
    await expect(client.batchStatus('batch-one')).rejects.toThrow();
  });
});
