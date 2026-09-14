import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  actor: { orgId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222' },
  headers: new Headers(), identity: vi.fn(), open: vi.fn(), close: vi.fn(),
  authenticate: vi.fn(), sql: vi.fn(), profiles: vi.fn(), coverage: vi.fn(), crosscheck: vi.fn(),
}));
vi.mock('next/headers', () => ({ headers: async () => mocks.headers }));
vi.mock('../server/request-context', () => ({ requestActor: mocks.identity, openWebDatabase: mocks.open }));
vi.mock('@wizard-ads/db', () => ({ withAuthenticatedActor: mocks.authenticate, readProfileFreshness: mocks.coverage }));
vi.mock('@wizard-ads/crosscheck-cli', () => ({ loadCrosscheckPanel: mocks.crosscheck }));
vi.mock('../../app/_lib/profiles', () => ({ listProfiles: mocks.profiles }));
import { readShellEvidence } from './shell-evidence-server';

const profileId = '33333333-3333-4333-8333-333333333333';
beforeEach(() => {
  vi.resetAllMocks();
  mocks.identity.mockResolvedValue(mocks.actor);
  mocks.open.mockReturnValue({ sql: mocks.sql, close: mocks.close });
  mocks.authenticate.mockImplementation(async (_db, _actor, read) => read(mocks.sql));
  mocks.profiles.mockResolvedValue([{ id: profileId, syncEnabled: true }]);
  mocks.coverage.mockResolvedValue({ entries: [] });
  mocks.crosscheck.mockResolvedValue({ chip: { verdict: 'no_data', tone: 'muted' } });
  mocks.sql.mockResolvedValue([{ count: 3 }]);
});

it('rechecks membership and reads the complete evidence on exactly one authenticated connection', async () => {
  const result = await readShellEvidence(profileId);
  expect(result).toMatchObject({ profileId, badges: { 'change-queue': null, timeline: 3 } });
  expect(result?.freshness).not.toBeNull();
  expect(result?.crosscheck).toEqual({ verdict: 'no_data', tone: 'muted' });
  expect(mocks.identity).toHaveBeenCalledWith(mocks.headers);
  expect(mocks.open).toHaveBeenCalledTimes(1);
  expect(mocks.authenticate).toHaveBeenCalledTimes(1);
  expect(mocks.authenticate.mock.calls[0]?.[1]).toEqual(mocks.actor);
  expect(mocks.profiles).toHaveBeenCalledWith({ sql: mocks.sql }, mocks.actor.orgId);
  expect(mocks.coverage).toHaveBeenCalledWith({ sql: mocks.sql }, mocks.actor, profileId);
  expect(mocks.crosscheck).toHaveBeenCalledWith({ sql: mocks.sql }, { orgId: mocks.actor.orgId, profileId });
  expect(mocks.sql.mock.calls[0]?.slice(1)).toEqual([mocks.actor.orgId, profileId]);
  expect(mocks.close).toHaveBeenCalledTimes(1);
  mocks.authenticate.mockRejectedValueOnce(new Error('Membership revoked'));
  expect(await readShellEvidence(profileId)).toBeNull();
  expect(mocks.identity).toHaveBeenCalledTimes(2);
  expect(mocks.authenticate).toHaveBeenCalledTimes(2);
  expect(mocks.coverage).toHaveBeenCalledTimes(1);
  expect(mocks.close).toHaveBeenCalledTimes(2);
});

it('refuses an explicit foreign profile before any evidence queries', async () => {
  expect(await readShellEvidence('44444444-4444-4444-8444-444444444444')).toBeNull();
  expect(mocks.coverage).not.toHaveBeenCalled();
  expect(mocks.crosscheck).not.toHaveBeenCalled();
  expect(mocks.sql).not.toHaveBeenCalled();
  expect(mocks.close).toHaveBeenCalledTimes(1);
});

it('resolves the default profile within the same transaction', async () => {
  expect((await readShellEvidence(null))?.profileId).toBe(profileId);
  expect(mocks.authenticate).toHaveBeenCalledTimes(1);
});

it('does not open an evidence session for an unauthenticated caller', async () => {
  mocks.identity.mockRejectedValue(new Error('Not signed in'));
  expect(await readShellEvidence(profileId)).toBeNull();
  expect(mocks.open).not.toHaveBeenCalled();
});

it('settles and closes failed reads without rejecting the page', async () => {
  mocks.coverage.mockRejectedValue(new Error('Database unavailable'));
  expect(await readShellEvidence(profileId)).toBeNull();
  expect(mocks.crosscheck).not.toHaveBeenCalled();
  expect(mocks.close).toHaveBeenCalledTimes(1);
});
