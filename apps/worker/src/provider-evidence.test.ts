import { expect, it, vi } from 'vitest';
import { ProviderCollectionConfig, ProviderEvidenceRun } from '@wizard-ads/shared';
import type { ClaimedJob } from '@wizard-ads/db';
import { registerProviderEvidence, type ProviderEvidenceDependencies } from './provider-evidence.js';
import { IngestionRegistry } from './ingestion-registry.js';
import { ingestionLaneJobTypes } from './ingestion-sources.js';
import { providerEvidenceSchedule } from './schedules.js';
import { providerEvidenceEnabledFromEnv } from './config.js';
const id = '00000000-0000-4000-8000-000000000091';
const at = '2026-06-01T00:00:00.000Z';
const config = ProviderCollectionConfig.parse({ id, scope: { orgId: id, profileId: id, marketplaceId: 'synthetic-market', amazonProfileId: 'synthetic-profile' }, family: 'tactical', operation: 'tactical.ListRecommendations', request: {}, enabled: true, maxPages: 3, maxRows: 100, cadence: 'daily' });
function harness(enabled = true) {
  const run = ProviderEvidenceRun.parse({ id, config, status: 'running', page: 0, nextToken: null, startedAt: at, observedAt: at, counts: { source: 0, parsed: 0, refused: 0, duplicates: 0, conflicts: 0, canonical: 0, written: 0, existing: 0, readback: 0 } });
  const deps: ProviderEvidenceDependencies = { enabled: () => enabled, prepare: vi.fn(async () => run), authorize: vi.fn(async () => {}), fail: vi.fn(async () => {}), read: vi.fn(async () => ({ rows: [], source: 0, refused: 0, nextToken: null, status: 'complete' as const })), persist: vi.fn(async (r, p) => ({ ...r, status: p.status, page: r.page + 1 })) };
  const coverage = vi.fn(async () => ({ offered: 1, written: 1, unchanged: 0 }));
  const registry = new IngestionRegistry(coverage); registerProviderEvidence(registry, deps);
  const payload = { type: 'provider.evidence.collect' as const, orgId: id, profileId: id, configId: id };
  const context = { job: { id, orgId: id, profileId: id, jobType: payload.type, payload } as ClaimedJob, payload, profile: { id, orgId: id, amazonProfileId: 'synthetic-profile', region: 'EU' as const, timezone: 'UTC', currencyCode: 'EUR' } };
  return { deps, run, coverage, dispatch: () => registry.dispatch(context) };
}
it('omitted flags and disabled sources make zero provider or persistence calls', async () => {
  expect(providerEvidenceEnabledFromEnv({})).toBe(false);
  const h = harness(false); await expect(h.dispatch()).rejects.toThrow('disabled');
  expect(h.deps.prepare).not.toHaveBeenCalled(); expect(h.deps.read).not.toHaveBeenCalled(); expect(h.coverage).not.toHaveBeenCalled();
  expect(providerEvidenceSchedule(config, false)).toBeNull(); expect(providerEvidenceSchedule({ ...config, enabled: false }, true)).toBeNull();
});
it('publishes verified empty evidence with original observation time and no execution authority', async () => {
  const h = harness(); await h.dispatch();
  expect(h.deps.read).toHaveBeenCalledTimes(1); expect(h.deps.persist).toHaveBeenCalledTimes(1);
  expect(h.coverage).toHaveBeenCalledWith(expect.objectContaining({ source: 'amazon_provider_evidence', status: 'complete', sourceRows: 0, loadedRows: 0, observedAt: at }), 0);
  expect(ingestionLaneJobTypes('evo-recommendation')).not.toContain('provider.evidence.collect');
  expect(ingestionLaneJobTypes('integrations')).toContain('provider.evidence.collect');
  expect(providerEvidenceSchedule(config, true)?.payload.type).toBe('provider.evidence.collect');
});
it('does not repeat provider calls for a completed checkpoint', async () => {
  const h = harness(); h.run.status = 'complete'; await h.dispatch(); expect(h.deps.read).not.toHaveBeenCalled(); expect(h.coverage).toHaveBeenCalledTimes(1);
});
it('records safe failed retrieval and publishes zero coverage on provider failure', async () => {
  const h = harness(); vi.mocked(h.deps.read).mockRejectedValue(new Error('arbitrary provider content'));
  await expect(h.dispatch()).rejects.toThrow('checkpoint retained'); expect(h.deps.fail).toHaveBeenCalledTimes(1); expect(h.coverage).not.toHaveBeenCalled();
});
it('keeps partial retrieval coverage partial', async () => {
  const h = harness(); vi.mocked(h.deps.read).mockResolvedValue({ rows: [], source: 0, refused: 0, nextToken: null, status: 'partial' });
  await h.dispatch(); expect(h.coverage).toHaveBeenCalledWith(expect.objectContaining({ status: 'partial' }), 0);
});

it('cannot route a report-backed extension around reporting recovery', async () => {
  const h = harness(); h.run.config = { ...h.run.config, family: 'benchmarks', operation: 'reports.create' };
  await expect(h.dispatch()).rejects.toThrow('configuration or scope refused');
  expect(h.deps.read).not.toHaveBeenCalled(); expect(h.coverage).not.toHaveBeenCalled();
});

it('does not publish complete coverage when a stored observation has expired', async () => {
  const h = harness(); h.run.status = 'complete'; h.run.earliestExpiry = at;
  await h.dispatch(); expect(h.deps.read).not.toHaveBeenCalled(); expect(h.coverage).toHaveBeenCalledWith(expect.objectContaining({ status: 'partial' }), 0);
});
