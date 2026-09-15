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
