import type { DbHandle } from '@wizard-ads/db';
import type { ReactElement } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ScreenActor } from '../../server/page-read';
import { context, profile } from '../synthetic-render-fixtures';
import { load } from './load';

const mocks = vi.hoisted(() => ({
  freshness: vi.fn(), crosscheck: vi.fn(), profiles: vi.fn(), authenticate: vi.fn(), sql: vi.fn(),
}));
vi.mock('../../server/load-freshness', () => ({ loadFreshness: mocks.freshness }));
vi.mock('@wizard-ads/crosscheck-cli', () => ({ loadCrosscheckPanel: mocks.crosscheck }));
vi.mock('@wizard-ads/db', () => ({ withAuthenticatedActor: mocks.authenticate }));
vi.mock('../../../app/_lib/profiles', () => ({ listProfiles: mocks.profiles }));

const actor = { orgId: context.active!.orgId, userId: context.user.id };
const handle = { sql: mocks.sql } as unknown as DbHandle;
function access(): ScreenActor {
  const readNullable: ScreenActor['readNullable'] = (run) => read(run);
  const read: ScreenActor['read'] = async (run) => run(handle, actor);
  return {
    entry: { state: 'ok', handle, context }, requestedProfile: profile.id,
    actor: () => actor, read, readSql: (run) => run(handle.sql),
    readNullable,
    snapshot: async () => { throw new Error('Unexpected snapshot'); },
    selectProfile: (profiles) => profiles[0] ?? null,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.profiles.mockResolvedValue([profile]);
  mocks.authenticate.mockImplementation(async (_handle, _actor, run) => run(handle.sql));
});

it('returns the workspace after one roster read and streams crosscheck without a page freshness read', async () => {
  const freshness = deferred<{ tone: 'good'; details: never[] }>();
  const crosscheck = deferred<null>();
  mocks.freshness.mockReturnValue(freshness.promise);
  mocks.crosscheck.mockReturnValue(crosscheck.promise);
  const authority = access();
  const readNullable = vi.spyOn(authority, 'readNullable');
  const data = await load(authority, { searchParams: { profile: profile.id }, params: {} });
  expect(data.view).toBe('ready');
  expect(readNullable).toHaveBeenCalledTimes(1);
  expect(mocks.profiles).toHaveBeenCalledTimes(1);
  expect(mocks.freshness).not.toHaveBeenCalled();
  expect(mocks.crosscheck).not.toHaveBeenCalled();
  if (data.view !== 'ready') throw new Error('Missing workspace');

  const banner = data.props.freshness;
  const render = banner.type as (props: unknown) => Promise<ReactElement>;
  const pending = render(banner.props);
  expect(mocks.freshness).not.toHaveBeenCalled();
  // Crosscheck starts independently; freshness is owned by the shell.
  expect(mocks.crosscheck).toHaveBeenCalledWith({ sql: handle.sql }, { orgId: actor.orgId, profileId: profile.id });
  expect(mocks.authenticate).toHaveBeenCalledWith(handle, actor, expect.any(Function));
  freshness.resolve({ tone: 'good', details: [] });
  crosscheck.resolve(null);
  const result = await pending;
  expect(result.props).toMatchObject({ children: null });
  expect(mocks.freshness).not.toHaveBeenCalled();
});

it('does not read freshness for empty or populated rosters', async () => {
  mocks.profiles.mockResolvedValue([]);
  expect(await load(access(), { searchParams: {}, params: {} })).toMatchObject({ view: 'empty' });
  expect(mocks.freshness).not.toHaveBeenCalled();
  mocks.profiles.mockResolvedValue([profile]);
  mocks.freshness.mockRejectedValue(new Error('Synthetic freshness failure'));
  mocks.crosscheck.mockResolvedValue(null);
  const data = await load(access(), { searchParams: {}, params: {} });
  if (data.view !== 'ready') throw new Error('Missing workspace');
  const render = data.props.freshness.type as (props: unknown) => Promise<ReactElement>;
  await expect(render(data.props.freshness.props)).resolves.toMatchObject({ props: { children: null } });
  expect(mocks.freshness).not.toHaveBeenCalled();
});

it('uses the topbar comparison dates in the workspace', async () => {
  const data = await load(access(), { searchParams: { from: '2026-07-01', to: '2026-07-14', compareFrom: '2026-05-01', compareTo: '2026-05-14' }, params: {} });
  expect(data).toMatchObject({ view: 'ready', props: { period: { start: '2026-07-01', end: '2026-07-14' }, comparison: { start: '2026-05-01', end: '2026-05-14' } } });
});
