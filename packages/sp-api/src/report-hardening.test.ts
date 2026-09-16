import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { SpApiClient, SpApiError, SpApiAmbiguousOutcome } from './index.js';

const input = { reportType: 'SYNTHETIC_REPORT', marketplaceId: 'synthetic-marketplace',
  dataStartTime: '2026-01-01T00:00:00Z', dataEndTime: '2026-01-02T00:00:00Z' };

describe('report-type-agnostic transport', () => {
  it.each([429, 500, 408])('does not repeat create after HTTP %s', async (status) => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response('{}', { status, headers: { 'retry-after': '7' } }))
      .mockResolvedValue(new Response(JSON.stringify({ reportId: 'duplicate-if-retried' })));
    const client = new SpApiClient({ endpoint: 'https://example.test', userAgent: 'synthetic', fetch,
      accessTokenProvider: { getAccessToken: async () => 'synthetic', invalidate: vi.fn() }, maxRetries: 10 });
    await expect(client.createReport(input)).rejects.toBeInstanceOf(status === 500 || status === 408 ? SpApiAmbiguousOutcome : SpApiError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['transport', 'invalid-json', 'missing-id'])('quarantines ambiguous create %s', async (failure) => {
    const fetch = vi.fn(async () => {
      if (failure === 'transport') throw new Error('synthetic');
      return new Response(failure === 'invalid-json' ? 'bad json' : '{}');
    });
    const client = new SpApiClient({ endpoint: 'https://example.test', userAgent: 'synthetic', fetch,
      accessTokenProvider: { getAccessToken: async () => 'synthetic' } });
    await expect(client.createReport(input)).rejects.toBeInstanceOf(SpApiAmbiguousOutcome);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])('downloads TSV without credentials (gzip=%s)', async (compressed) => {
    const tsv = 'sku\tunits\nsynthetic\t2\n';
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('x-amz-access-token')).toBeNull();
      return new Response(compressed ? new Uint8Array(gzipSync(tsv)) : tsv);
    });
    const client = new SpApiClient({ endpoint: 'https://example.test', userAgent: 'synthetic', fetch,
      accessTokenProvider: { getAccessToken: async () => { throw new Error('must not authenticate download'); } } });
    expect(await client.downloadReportDocumentText({ reportDocumentId: 'synthetic', url: 'https://example.test/document',
      compressionAlgorithm: compressed ? 'GZIP' : null })).toBe(tsv);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('bounded streamed report documents', () => {
  it.each([
    { name: 'plain oversize', gzip: false, bytes: new TextEncoder().encode('x'.repeat(64)), inputLimit: 16, outputLimit: 128 },
    { name: 'compressed oversize', gzip: true, bytes: new Uint8Array(gzipSync('synthetic document')), inputLimit: 8, outputLimit: 128 },
    { name: 'excessive gzip expansion', gzip: true, bytes: new Uint8Array(gzipSync('x'.repeat(4096))), inputLimit: 128, outputLimit: 64 },
  ])('cancels $name before returning document text', async ({gzip,bytes,inputLimit,outputLimit}) => {
    let signal: AbortSignal | null | undefined;
    const cancel=vi.fn();
    let offset=0;
    const body=new ReadableStream<Uint8Array>({
      pull(controller){
        if(offset<bytes.length){controller.enqueue(bytes.slice(offset,offset+4));offset+=4;}
        else if(gzip && inputLimit===128)controller.close();
        else controller.enqueue(new Uint8Array(4));
      }, cancel,
    });
    const client=new SpApiClient({endpoint:'https://example.test',userAgent:'synthetic',
      accessTokenProvider:{getAccessToken:async()=>{throw new Error('No credentials for downloads');}},
      maxDocumentBytes:inputLimit,maxDecompressedDocumentBytes:outputLimit,
      fetch:async(_url,init)=>{signal=init?.signal;return new Response(body);}});
    await expect(client.downloadReportDocumentText({reportDocumentId:'bounded',url:'https://example.test/document',compressionAlgorithm:gzip?'GZIP':null}))
      .rejects.toThrow('byte limit');
    expect(signal?.aborted).toBe(true);
    if(inputLimit!==128)await vi.waitFor(()=>expect(cancel).toHaveBeenCalledOnce());
  });
});
