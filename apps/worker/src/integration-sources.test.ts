import { describe, expect, it, vi } from 'vitest';
import type { ClaimedJob } from '@wizard-ads/db';
import type { JobPayload } from '@wizard-ads/shared';
import { registerIntegrationSources } from './integration-sources.js';
import { IngestionRegistry } from './ingestion-registry.js';
import type { IntegrationHandlers } from './worker.js';
import { parseProduct, keepaMinutesToDate } from '@wizard-ads/keepa-api';
import { runKeepaSync, type KeepaSyncDeps } from './keepa.js';

const orgId = '11111111-1111-4111-8111-111111111111';
const profileId = '22222222-2222-4222-8222-222222222222';
const now = () => new Date('2026-08-24T12:00:00.000Z');
const base = { orgId, profileId };

describe('production registered integrations', () => {
  const cases: Array<[JobPayload, IntegrationHandlers, string]> = [
    [{ ...base,type: 'keepa.sync',includeCompetitors: false }, { keepaSync: async () => ({ requested: 2,returned: 1,missing: ['synthetic'],observationsWritten: 1,observationsExisting: 0,earliestObservedAt: '2026-08-24T00:00:00.000Z',observedAt: '2026-08-24T00:00:00.000Z' }) }, '2026-08-24'],
    [{ ...base,type: 'rank.sync' }, { rankSync: async () => ({ observations: 2,uniqueObservations: 1,loaded: 1,observedOn: '2026-08-23' }) }, '2026-08-23'],
    [{ ...base,type: 'economics.sync' }, { economicsSync: async () => ({ asinsSelected: 3,rowsLoaded: 1,productCallsSucceeded: 2,productsSkippedIncomplete: 1,capturedOn: '2026-08-22' }) }, '2026-08-22'],
    [{ ...base,type: 'sqp.request',marketplaceId: 'synthetic',asins: ['B000000001'],weekStart: '2026-08-16',weekEnd: '2026-08-22' }, { sqpRequest: async () => ({ observedAt: '2026-08-23T00:00:00.000Z',ingestion: { sourceRows: 3,parsedRows: 3,refusedRows: 0,status: 'promoted',deduplicatedRows: 1,promotedRows: 1,upserts: 1,canonicalRows: 1 } }) }, '2026-08-22'],
    [{ ...base,type: 'sqp.request',marketplaceId: 'synthetic',asins: ['B000000001'],weekStart: '2026-08-16',weekEnd: '2026-08-22' }, { sqpRequest: async () => ({ observedAt: '2026-08-23T00:00:00.000Z',ingestion: { sourceRows: 3,parsedRows: 3,refusedRows: 0,status: 'already_promoted',deduplicatedRows: 1,promotedRows: 0,upserts: 0,canonicalRows: 1 } }) }, '2026-08-22'],
    [{ ...base,type: 'keepa.sync',includeCompetitors: false }, { keepaSync: async () => ({ requested: 1,returned: 1,missing: [],observationsWritten: 0,observationsExisting: 1,earliestObservedAt: '2026-08-20T00:00:00.000Z',observedAt: '2026-08-20T00:00:00.000Z' }) }, '2026-08-20'],
  ];
  it.each(cases)('publishes source/load accounting and coverage for %s', async (payload, handlers, date) => {
    const producer = vi.fn(async () => ({ offered: 1,written: 1,unchanged: 0 }));
    const registry = new IngestionRegistry(producer);
    registerIntegrationSources(registry,handlers,now);
    const job: ClaimedJob = { ...base,id: '33333333-3333-4333-8333-333333333333',jobType: payload.type,payload,
      attempts: 1,maxAttempts: 2,claim: null,claimedBy: 'synthetic',dedupeKey: null };
    await registry.dispatch({ job,payload,profile: { id: profileId,orgId,amazonProfileId: 'synthetic',region: 'EU',timezone: 'UTC',currencyCode: 'USD' } });
    expect(producer).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ orgId,profileId,coveredThrough: date,loadedRows: 1,countsMatch: true }),1);
  });
  it('keeps the provider timestamp when all Keepa observations already exist', async () => {
    const observedAt = keepaMinutesToDate(8_200_000);
    const product = parseProduct({ asin: 'B000000001',lastUpdate: 8_200_000,csv: [] },observedAt.getTime());
    const deps: KeepaSyncDeps = {
      activeConnection: async () => ({ id: '33333333-3333-4333-8333-333333333333',config: {} }),
      readCredential: async () => 'synthetic',
      scope: async () => ({ marketplace: 'US',ownAsins: ['B000000001'],competitorLinks: [] }),
      previous: async () => [],
      loadObservations: async (rows) => {
        expect(rows).toHaveLength(1);
        expect(rows[0]!.observedAt).toEqual(observedAt);
        return { offered: 1,written: 0,existing: 1 };
      },
      loadEvents: async () => ({ offered: 0,written: 0,existing: 0,inserted: [] }),
      writeInsight: async () => { throw new Error('No new events expected'); },
      markSynced: async () => {},
      createClient: () => ({ products: async () => ({ requested: 1,returned: 1,missing: [],products: [product],
        tokenState: { tokensLeft: 50,refillInMs: 1_000,refillRate: 10,tokensConsumed: 1,requestsMade: 1 } }) }),
      now,
    };
    expect(await runKeepaSync(deps,{ ...base,type: 'keepa.sync',includeCompetitors: false })).toMatchObject({
      observationsWritten: 0,observationsExisting: 1,earliestObservedAt: observedAt.toISOString(),observedAt: observedAt.toISOString(),
    });
  });
});
