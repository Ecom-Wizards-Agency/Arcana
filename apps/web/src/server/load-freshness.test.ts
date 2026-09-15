import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  read: vi.fn(), close: vi.fn(), authenticate: vi.fn(),
  sql: {},
}));
vi.mock('@wizard-ads/db', () => ({
  readProfileFreshness: mocks.read,
  withAuthenticatedActor: mocks.authenticate,
}));
vi.mock('./request-context', () => ({
  openWebDatabase: () => ({ sql: mocks.sql, close: mocks.close }),
}));
import { loadFreshness } from './load-freshness';

const actor = { orgId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222' };
const profileId = '33333333-3333-4333-8333-333333333333';
beforeEach(() => {
  vi.resetAllMocks();
  mocks.authenticate.mockImplementation(async (_handle, _actor, read) => read(mocks.sql));
});
it('reads coverage under actor authority and assesses it', async () => {
  mocks.read.mockResolvedValue({ answeredBy: 'coverage', entries: [{
    source: 'selling_partner_api', reportType: 'sales_and_traffic', status: 'complete',
    coveredThrough: '2026-08-13', observedAt: new Date().toISOString(),
    sourceRows: null, parsedRows: null, loadedRows: null, refusedRows: null, countsMatch: null,
  }] });
  const result = await loadFreshness(actor, profileId);
  expect(mocks.authenticate.mock.calls[0]?.[1]).toEqual(actor);
  expect(mocks.read).toHaveBeenCalledWith({ sql: mocks.sql }, actor, profileId);
  expect(result.tone).toBe('good');
  expect(result.details).toHaveLength(1);
  expect(result.details[0]).not.toContain('0 rows');
  expect(mocks.close).toHaveBeenCalledTimes(1);
});
it('closes the connection when authorization fails', async () => {
  mocks.authenticate.mockRejectedValue(new Error('Resource not found'));
  await expect(loadFreshness(actor, profileId)).rejects.toThrow('Resource not found');
  expect(mocks.read).not.toHaveBeenCalled();
  expect(mocks.close).toHaveBeenCalledTimes(1);
});
