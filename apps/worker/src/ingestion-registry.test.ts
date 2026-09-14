import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { JobType, type JobPayload } from '@wizard-ads/shared';
import type { ClaimedJob } from '@wizard-ads/db';
import { IngestionRegistry, ReportCoverageCompletion, type IngestionHandlers, type TransactionalIngestionHandlers } from './ingestion-registry.js';
import { INGESTION_SOURCES, ingestionLaneJobTypes } from './ingestion-sources.js';
import { PermanentJobError, RetryableJobError, SyncWorker } from './worker.js';
import type { WorkerStore } from './store.js';

const orgId = '11111111-1111-4111-8111-111111111111';
const profileId = '22222222-2222-4222-8222-222222222222';
const payload: Extract<JobPayload, { type: 'history.bootstrap' }> = {
  type: 'history.bootstrap', orgId, profileId, reportType: 'spCampaigns', source: 'amazon_reporting_v3', cursorDate: null,
};
const counts = { sourceRows: 3, parsedRows: 2, refusedRows: 1, loadedRows: 2, verifiedLoadedRows: 2 };
const source = { jobType: 'history.bootstrap' as const, source: 'synthetic', reportType: 'syntheticRows',
  laneAffinity: [], counts: ['offered', 'written'] };
function handlers(execute = async () => ({ offered: 3, written: 2 })): IngestionHandlers<'history.bootstrap', null, { offered: number; written: number }> {
  return { source, plan: () => null, execute, counts: () => counts, coverage: { target: () => ({
    reportType: 'syntheticRows', grain: 'row', status: 'partial', earliestDate: '2026-01-01',
    coveredThrough: '2026-01-01', settledThrough: null, observedAt: '2026-01-02T00:00:00.000Z',
  }) } };
}
function harness(execute?: () => Promise<{ offered: number; written: number }>, transform = (value: ReturnType<typeof handlers>) => value) {
  let attempts = 0;
  let claimed = false;
  const finish = vi.fn(); const deadLetter = vi.fn();
  const recordCoverage = vi.fn(async () => ({ offered: 1, written: 1, unchanged: 0 }));
  const store = {
    claim: async () => {
      if (claimed) return []; claimed = true; attempts++;
      const job: ClaimedJob = { id: '33333333-3333-4333-8333-333333333333', orgId, profileId,
        jobType: payload.type, payload, attempts, maxAttempts: 2, dedupeKey: null, claim: null, claimedBy: 'synthetic' };
      return [job];
    },
    profile: async () => ({ id: profileId, orgId, amazonProfileId: 'synthetic', region: 'EU', timezone: 'UTC' }),
    finish, deadLetter, recordCoverage,
  } as unknown as WorkerStore;
  const worker = new SyncWorker({ workerId: 'synthetic', store, logger: { info: vi.fn(), error: vi.fn() },
    sources: (registry) => registry.register(transform(handlers(execute))) });
  return { worker, finish, deadLetter, recordCoverage, retry: () => { claimed = false; } };
}

describe('registered source queue execution', () => {
  it('executes, reconciles counts, produces coverage and preserves the queue result', async () => {
    const execute = vi.fn(async () => ({ offered: 3, written: 2 }));
    const h = harness(execute);
    expect(await h.worker.drainOnce()).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(h.recordCoverage).toHaveBeenCalledTimes(1);
    expect(h.recordCoverage).toHaveBeenCalledWith(expect.objectContaining({ orgId, profileId, source: 'synthetic',
      sourceRows: 3, parsedRows: 2, refusedRows: 1, loadedRows: 2, countsMatch: true }), 2);
    expect(h.finish).toHaveBeenCalledWith(expect.any(String), 'succeeded', { result: { offered: 3, written: 2 } });
  });
  it('retries through the same worker with provider pacing, then writes one observation', async () => {
    const execute = vi.fn().mockRejectedValueOnce(new RetryableJobError('synthetic quota', 19))
      .mockResolvedValue({ offered: 3, written: 2 });
    const h = harness(execute);
    await h.worker.drainOnce();
    expect(h.finish).toHaveBeenLastCalledWith(expect.any(String), 'failed', expect.objectContaining({ retryIn: '19 seconds' }));
    expect(h.recordCoverage).not.toHaveBeenCalled();
    h.retry(); await h.worker.drainOnce();
    expect(execute).toHaveBeenCalledTimes(2);
    expect(h.recordCoverage).toHaveBeenCalledTimes(1);
    expect(h.finish).toHaveBeenLastCalledWith(expect.any(String), 'succeeded', expect.anything());
  });
  it('dead-letters a registered permanent failure without publishing freshness', async () => {
    const h = harness(async () => { throw new PermanentJobError('synthetic refusal'); });
    await h.worker.drainOnce();
    expect(h.deadLetter).toHaveBeenCalledExactlyOnceWith(expect.any(String), 'synthetic refusal');
    expect(h.recordCoverage).not.toHaveBeenCalled();
    expect(h.finish).not.toHaveBeenCalled();
  });
  it('refuses count loss before the coverage producer', async () => {
    const h = harness(undefined, (value) => ({ ...value, counts: () => ({ ...counts, loadedRows: 1 }) }));
    await h.worker.drainOnce();
    expect(h.recordCoverage).not.toHaveBeenCalled();
    expect(h.finish).toHaveBeenCalledWith(expect.any(String), 'failed', expect.anything());
  });
  it('rejects missing coverage during registration and duplicate source identities', () => {
    const registry = new IngestionRegistry(vi.fn());
    const invalid = { ...handlers(), coverage: undefined } as unknown as ReturnType<typeof handlers>;
    expect(() => registry.register(invalid)).toThrow('coverage at registration');
    registry.register(handlers());
    expect(() => registry.register(handlers())).toThrow('Duplicate ingestion');
  });
  it('does not accept a successful provider call with an unaccounted coverage write', async () => {
    const h = harness(); h.recordCoverage.mockResolvedValue({ offered: 1, written: 0, unchanged: 0 });
    await h.worker.drainOnce();
    expect(h.finish).toHaveBeenCalledWith(expect.any(String), 'failed', expect.objectContaining({ error: 'Ingestion coverage write counts do not reconcile' }));
  });
  it('requires the transactional coverage producer and its durable completion receipt', async () => {
    const transactional: TransactionalIngestionHandlers<'history.bootstrap', ReportCoverageCompletion, { rows: number }> = {
      source, plan: (_context, completion) => completion,
      execute: async () => ({ rows: 2 }), counts: (_result, completion) => completion.accounting(),
      coverage: { kind: 'report-ledger' },
    };
    expect(() => new IngestionRegistry(vi.fn()).registerTransactionalSource(transactional)).toThrow('coverage at registration');
    const completeReport = vi.fn(async () => {});
    const registry = new IngestionRegistry(vi.fn(), () => new ReportCoverageCompletion({ completeReport, finishAttributedReport: vi.fn() }));
    const invalid = { ...transactional, coverage: undefined } as unknown as typeof transactional;
    expect(() => registry.registerTransactionalSource(invalid)).toThrow('coverage at registration');
    registry.registerTransactionalSource(transactional);
    const job = { orgId, profileId, payload, jobType: payload.type } as ClaimedJob;
    await expect(registry.dispatch({ job, payload, profile: { id: profileId, orgId, amazonProfileId: 'synthetic', region: 'EU', timezone: 'UTC', currencyCode: 'USD' } }))
      .rejects.toThrow('skipped coverage completion');
    expect(completeReport).not.toHaveBeenCalled();
  });
});

describe('source-derived deployment lanes', () => {
  it('accounts for every queue type exactly once', () => {
    const types = INGESTION_SOURCES.map((entry) => entry.jobType);
    expect(types).toHaveLength(JobType.options.length);
    expect(new Set(types)).toEqual(new Set(JobType.options));
    expect(ingestionLaneJobTypes('evo-report')).toEqual(['creative.sync', 'report.request', 'report.poll', 'report.fetch']);
  });
  it('keeps immutable artifact contracts equal to the registered lane sets', async () => {
    const report = await readFile(new URL('../../../docs/deploy/openspell-report-worker-contract.mjs', import.meta.url), 'utf8');
    const recommendations = await readFile(new URL('../../../docs/deploy/openspell-recommendation-worker-contract.mjs', import.meta.url), 'utf8');
    expect(report).toContain(`'${ingestionLaneJobTypes('evo-report').join(',')}'`);
    expect(recommendations).toContain(`WORKER_JOB_TYPES: '${ingestionLaneJobTypes('evo-recommendation').join(',')}'`);
  });
});
