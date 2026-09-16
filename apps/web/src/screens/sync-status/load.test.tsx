import { beforeEach, expect, it, vi } from 'vitest';
import type { ScreenActor } from '../../server/page-read';
import { context, profile } from '../synthetic-render-fixtures';
import { load } from './load';
const mocks = vi.hoisted(() => ({ profiles: vi.fn(), status: vi.fn(), evidence: vi.fn(), spEvidence: vi.fn() }));
vi.mock('../../../app/_lib/profiles', () => ({ listProfiles: mocks.profiles }));
vi.mock('../../data/sync-status', () => ({ loadSyncStatus: mocks.status }));
vi.mock('@wizard-ads/db', () => ({ readCoreReportEvidence: mocks.evidence, readSpReportEvidence: mocks.spEvidence }));
beforeEach(() => { vi.resetAllMocks(); mocks.profiles.mockResolvedValue([profile]); mocks.status.mockResolvedValue({ profiles: [] }); mocks.evidence.mockResolvedValue([{ family: 'spAdvertisedProduct', status: 'unmeasured' }]); mocks.spEvidence.mockResolvedValue({ state: 'unavailable', reports: [] }); });
it('loads family coverage for the standard selected profile without a query parameter', async () => {
  const selectProfile = vi.fn(() => profile);
  const handle = { sql: vi.fn() };
  const actor = { entry: { state: 'ok', context }, requestedProfile: profile.id, selectProfile,
    read: async (run: (handle: unknown) => unknown) => run(handle), readSql: async (run: (sql: unknown) => unknown) => run(handle.sql),
  } as unknown as ScreenActor;
  const result = await load(actor, { searchParams: {}, params: {} });
  expect(selectProfile).toHaveBeenCalledWith([profile], undefined);
  expect(mocks.status).toHaveBeenCalledWith(handle, context.active!.orgId, profile.id);
  expect(mocks.evidence).toHaveBeenCalledTimes(1);
  expect(mocks.evidence).toHaveBeenCalledWith(handle, expect.objectContaining({ orgId: context.active!.orgId, profileId: profile.id }));
  expect(result?.props).toHaveProperty('coreEvidence', [{ family: 'spAdvertisedProduct', status: 'unmeasured' }]);
  expect(mocks.spEvidence).toHaveBeenCalledTimes(3);
  for (const family of ['retail', 'aba', 'catalogue']) {
    expect(mocks.spEvidence).toHaveBeenCalledWith(handle, expect.objectContaining({ orgId: context.active!.orgId, profileId: profile.id, family, latest: true }));
  }
  expect(result?.props).toHaveProperty('sources', ['retail', 'aba', 'catalogue'].map(family => ({ family, evidence: { state: 'unavailable', reports: [] } })));
});
