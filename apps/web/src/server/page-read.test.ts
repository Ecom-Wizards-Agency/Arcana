import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScreenDescriptor } from '../screens/types';
import { pageRead } from './page-read';
import type * as RequestContext from './request-context';
import { RequestAuthError } from './request-context';

const mocks = vi.hoisted(() => ({
  requestActor: vi.fn(), open: vi.fn(), close: vi.fn(), transaction: vi.fn(), snapshot: vi.fn(),
  identity: vi.fn(), user: vi.fn(), database: vi.fn(), context: vi.fn(), authorize: vi.fn(), preference: vi.fn(),
}));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
vi.mock('next/navigation', () => ({
  redirect: (href: string) => { throw new Error(`redirect:${href}`); },
  notFound: () => { throw new Error('not-found'); },
}));
vi.mock('@wizard-ads/db', () => ({
  withAuthenticatedActor: mocks.transaction,
  withAuthenticatedReadSnapshot: mocks.snapshot,
}));
vi.mock('./request-context', async (importOriginal) => ({
  ...await importOriginal<typeof RequestContext>(),
  requestActor: mocks.requestActor, openWebDatabase: mocks.open,
}));
vi.mock('../auth/security-authorization', () => ({ currentOperatorIdentity: mocks.identity, authorizeOperatorRole: mocks.authorize }));
vi.mock('../auth/session', () => ({ currentUser: mocks.user }));
vi.mock('../data/db', () => ({ database: mocks.database }));
vi.mock('../data/orgs', () => ({ resolveOrgContext: mocks.context }));
vi.mock('../../app/_lib/profiles', () => ({ requestedProfileId: mocks.preference }));

const actor = { orgId: 'synthetic-org', userId: 'synthetic-user' };
const user = { id: actor.userId, email: 'operator@example.test' };
const membership = { orgId: actor.orgId, role: 'owner', slug: 'synthetic-org', name: 'Synthetic organization' };
const context = { user, active: membership, memberships: [membership] };
const sql = Object.assign(vi.fn(), {});
const handle = { sql };
function screen<T>(load: ScreenDescriptor<T>['load'], changes: Partial<ScreenDescriptor<T>> = {}): ScreenDescriptor<T> {
  return {
    id: 'synthetic', path: '/synthetic', route: 'page', nav: null,
    guard: { kind: 'requested' }, prefetch: 'cheap', rollout: { enabled: true }, states: [],
    entry: 'request-message', specs: [], load, client: async () => () => null, ...changes,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requestActor.mockResolvedValue(actor);
  mocks.close.mockResolvedValue(undefined);
  mocks.open.mockReturnValue({ ...handle, close: mocks.close });
  mocks.transaction.mockImplementation(async (_handle, _actor, run) => run(sql));
  mocks.snapshot.mockImplementation(async (_handle, _actor, run) => run({ ...handle, snapshot: true }));
  mocks.identity.mockResolvedValue({ user, security: null });
  mocks.user.mockResolvedValue(user);
  mocks.database.mockReturnValue(handle);
  mocks.context.mockResolvedValue(context);
  mocks.authorize.mockReturnValue({ status: 'ok' });
  mocks.preference.mockImplementation(async (requested) => requested);
});

describe('pageRead admission and lifetime', () => {
  it('closes one authenticated read and passes the resolved actor', async () => {
    const result = await pageRead(screen((access) => access.read(async (query, identity) => ({ sameSql: Object.is(query.sql, sql), identity }))));
    expect(result).toEqual({ sameSql: true, identity: actor });
    expect(mocks.requestActor).toHaveBeenCalledTimes(1);
    expect(mocks.open).toHaveBeenCalledTimes(1);
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(mocks.transaction.mock.calls[0]?.[1]).toEqual(actor);
  });
  it.each(['gate-message', 'account-security'] as const)('reuses the %s pool with one authenticated transaction and no second connection', async (entry) => {
    const read = vi.fn(async () => 'roster');
    expect(await pageRead(screen((access) => access.read(read), { entry }))).toBe('roster');
    expect(mocks.context).toHaveBeenCalledTimes(1);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.transaction).toHaveBeenCalledWith(handle, actor, expect.any(Function));
    expect(read).toHaveBeenCalledWith({ sql }, actor);
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
  });
  it('rechecks membership before using a gate pool and leaves its lifetime to the process', async () => {
    mocks.transaction.mockRejectedValue(new Error('Resource not found'));
    const read = vi.fn(async () => 'forbidden');
    await expect(pageRead(screen((access) => access.read(read), { entry: 'gate-message' })))
      .rejects.toThrow('Resource not found');
    expect(read).not.toHaveBeenCalled();
    expect(mocks.requestActor).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.close).not.toHaveBeenCalled();
  });
  it.each([
    [new RequestAuthError('Sign in', 401), '/login'],
    [new RequestAuthError('Challenge', 403, 'additional_authentication_required', '/auth/mfa/challenge?next=%2Fsynthetic'), '/auth/mfa/challenge?next=%2Fsynthetic'],
  ])('preserves authentication continuation before opening a page connection', async (error, destination) => {
    mocks.requestActor.mockRejectedValue(error);
    await expect(pageRead(screen(async () => 'unreachable'))).rejects.toThrow(`redirect:${destination}`);
    expect(mocks.open).not.toHaveBeenCalled();
  });
  it('preserves request errors for the screen safe-message view', async () => {
    const failure = new RequestAuthError('Account security could not be verified', 503);
    mocks.requestActor.mockRejectedValue(failure);
    const descriptor = screen(async (access) => {
      try { return await access.read(async () => 'unexpected'); }
      catch (error) { return error; }
    });
    expect(await pageRead(descriptor)).toBe(failure);
    expect(mocks.open).not.toHaveBeenCalled();
  });
  it('keeps gate messages, explicit organization scope, and gate security failures', async () => {
    const descriptor = screen(async (access) => access.entry, { entry: 'gate-message', preferredOrg: 'query' });
    mocks.context.mockResolvedValue({ ...context, active: null });
    expect(await pageRead(descriptor, { org: 'synthetic-foreign-org' })).toMatchObject({ state: 'no-org' });
    expect(mocks.context).toHaveBeenCalledWith(handle, user, 'synthetic-foreign-org');
    mocks.database.mockReturnValue(null);
    expect(await pageRead(descriptor)).toEqual({ state: 'no-database' });
    mocks.identity.mockResolvedValue({ user: null, security: { state: 'unavailable' } });
    await expect(pageRead(descriptor)).rejects.toThrow('redirect:/login?error=account+security+could+not+be+verified');
  });
  it('keeps account security reachable before MFA assurance', async () => {
    const result = await pageRead(screen(async (access) => access.entry, { entry: 'account-security' }));
    expect(result.state).toBe('ok');
    expect(mocks.identity).not.toHaveBeenCalled();
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.requestActor).not.toHaveBeenCalled();
    expect(mocks.user).toHaveBeenCalledTimes(1);
  });
  it('resolves the requested profile and preserves repeated query values in its canonical URL', async () => {
    mocks.preference.mockResolvedValue('synthetic-remembered');
    const descriptor = screen(async (access) => access.selectProfile([
      { id: 'synthetic-remembered', label: 'Synthetic account', syncEnabled: true },
    ]), { path: '/', guard: { kind: 'requested', canonicalProfile: true } });
    await expect(pageRead(descriptor, { filter: ['one', 'two'], from: '2026-08-01' }))
      .rejects.toThrow('redirect:/?profile=synthetic-remembered&filter=one&filter=two&from=2026-08-01');
  });
  it('uses the branded snapshot boundary and closes after a failed snapshot', async () => {
    mocks.snapshot.mockRejectedValue(new Error('Synthetic snapshot failure'));
    await expect(pageRead(screen((access) => access.snapshot(async () => 'unused')))).rejects.toThrow('Synthetic snapshot failure');
    expect(mocks.snapshot).toHaveBeenCalledTimes(1);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });
  it('does not release deferred reads before their evidence settles', async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const result = await pageRead(screen(async (access) => ({
      deferred: access.read(async () => { await pending; return 'evidence'; }),
      critical: 'workspace',
    })));
    expect(result.critical).toBe('workspace');
    expect(mocks.close).not.toHaveBeenCalled();
    finish();
    expect(await result.deferred).toBe('evidence');
    expect(mocks.close).toHaveBeenCalledTimes(1);
  });
  it('refuses disabled pages and disabled Grid presets before authentication', async () => {
    const load = vi.fn<ScreenDescriptor<string>['load']>(async () => 'unused');
    await expect(pageRead(screen(load, { rollout: { enabled: false } }))).rejects.toThrow('not-found');
    for (const entity of ['products', 'placements']) {
      await expect(pageRead(screen(load, { id: 'grid', path: '/grid' }), { entity })).rejects.toThrow('not-found');
    }
    expect(load).not.toHaveBeenCalled();
    expect(mocks.requestActor).not.toHaveBeenCalled();
  });
  it('preserves every query value when redirecting old Home and Queries links', async () => {
    const { descriptor: homeAlias } = await import('../screens/dashboard/descriptor');
    const { descriptor: queriesAlias } = await import('../screens/queries/descriptor');
    const query = { profile: 'synthetic-profile', filter: ['one', 'two'], q: 'space & slash/' };
    const encoded = new URLSearchParams([['profile', query.profile], ['filter', 'one'], ['filter', 'two'], ['q', query.q]]).toString();
    await expect(pageRead(homeAlias, query)).rejects.toThrow(`redirect:/?${encoded}`);
    await expect(pageRead(queriesAlias, query)).rejects.toThrow(`redirect:/query-intelligence?${encoded}`);
    expect(mocks.requestActor).not.toHaveBeenCalled();
  });
  it('leaves compatibility redirects and the fragment bridge unauthenticated until they read', async () => {
    for (const entry of ['redirect', 'feedback-bridge'] as const) {
      expect(await pageRead(screen(async () => 'bridge', { entry }))).toBe('bridge');
    }
    expect(mocks.requestActor).not.toHaveBeenCalled();
    await pageRead(screen((access) => access.read(async () => 'lookup'), { entry: 'feedback-bridge' }));
    expect(mocks.requestActor).toHaveBeenCalledTimes(1);
  });
});

