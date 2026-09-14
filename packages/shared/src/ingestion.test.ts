import { describe, expect, it } from 'vitest';
import { IngestionCounts, IngestionSource, isPermanentProviderFailure, isProviderFailure } from './index.js';

describe('ingestion contracts', () => {
  it('keeps provider retry classification structural and bounded', () => {
    const failure = { retryable: false, provider: 'synthetic', kind: 'parse' };
    expect(isPermanentProviderFailure(failure)).toBe(true);
    expect(isPermanentProviderFailure(new Error('unclassified'))).toBe(false);
    expect(isProviderFailure({ ...failure, retryAfterSeconds: -1 })).toBe(false);
  });
  it('requires descriptor counts and reconciles aggregation independently', () => {
    expect(IngestionSource.safeParse({ jobType: 'rank.sync', source: 'synthetic', laneAffinity: [] }).success).toBe(false);
    const counts = { sourceRows: 4, parsedRows: 3, refusedRows: 1, loadedRows: 1, verifiedLoadedRows: 1 };
    expect(IngestionCounts.parse(counts)).toEqual(counts);
    expect(IngestionCounts.safeParse({ ...counts, verifiedLoadedRows: 2 }).success).toBe(false);
    expect(IngestionCounts.safeParse({ ...counts, sourceRows: 5 }).success).toBe(false);
  });
});
