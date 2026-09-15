import { withAuthenticatedActor, withAuthenticatedReadSnapshot, type DbHandle, type QueryHandle } from '@wizard-ads/db';
import type { OrgActor } from '@wizard-ads/shared';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { cache } from 'react';
import { requestedProfileId } from '../../app/_lib/profiles';
import { authorizeOperatorRole, currentOperatorIdentity } from '../auth/security-authorization';
import { currentUser } from '../auth/session';
import { canonicalProfilePath, resolveActiveProfile, type ActiveProfileCandidate } from '../data/active-profile';
import { database } from '../data/db';
import { resolveOrgContext, type OrgContext } from '../data/orgs';
import { isDatabaseUnreachable } from '../db-unreachable';
import { screenEnabled, type ScreenDescriptor, type ScreenMetadata, type ScreenParams, type ScreenSearchParams } from '../screens/types';
import { authenticationDestination, openWebDatabase, requestActor, RequestAuthError } from './request-context';

export type PageEntry =
  | { state: 'ok'; handle: DbHandle; context: OrgContext; }
  | { state: 'no-database'; }
  | { state: 'no-org'; context: OrgContext; };

/** Server-only authority. Views receive loaded props, never this capability. */
export interface ScreenActor {
  readonly entry: PageEntry;
  readonly requestedProfile: string | undefined;
  actor(): OrgActor;
  read<T>(read: (handle: QueryHandle, actor: OrgActor) => Promise<T>): Promise<T>;
  readSql<T>(read: (sql: QueryHandle['sql']) => Promise<T>): Promise<T>;
  readNullable<T>(read: (handle: QueryHandle) => Promise<T>): Promise<T | null>;
  snapshot<T>(read: Parameters<typeof withAuthenticatedReadSnapshot<T>>[2]): Promise<T>;
  selectProfile<T extends ActiveProfileCandidate>(profiles: readonly T[], requested?: string): T | null;
}

async function messageEntry(screen: ScreenMetadata, query: ScreenSearchParams): Promise<PageEntry> {
  const identity = screen.entry === 'account-security' ? null : await currentOperatorIdentity();
  const user = identity === null ? await currentUser() : identity.user;
  if (!user) {
    if (identity?.security?.state === 'unavailable') redirect('/login?error=account+security+could+not+be+verified');
    redirect('/login');
  }
  const handle = database();
  if (handle === null) return { state: 'no-database' };
  let context: OrgContext;
  try {
    const preferred = screen.preferredOrg === 'query' && typeof query['org'] === 'string' ? query['org'] : undefined;
    context = await resolveOrgContext(handle, user, preferred);
  } catch (error) {
    if (isDatabaseUnreachable(error)) return { state: 'no-database' };
    throw error;
  }
  if (!context.active) return { state: 'no-org', context };
  if (identity !== null) {
    // The compatibility URL preserves existing authentication continuations.
    const authorization = authorizeOperatorRole(identity, context.active.role, '/dashboard');
    if (authorization.status === 'challenge') redirect(authorization.href);
    if (authorization.status === 'error') redirect('/login?error=account+security+could+not+be+verified');
  }
  return { state: 'ok', handle, context };
}

/** Resolve once; each read owns an authenticated transaction until it settles. */
export async function pageRead<Data>(
  descriptor: ScreenDescriptor<Data>,
  searchParams: ScreenSearchParams | Promise<ScreenSearchParams> = {},
  routeParams: Record<string, string> | Promise<Record<string, string>> = {},
): Promise<Data> {
  const input: ScreenParams = { searchParams: await searchParams, params: await routeParams };
  return readPage(descriptor, JSON.stringify(input));
}

/** React scopes this cache to one request, including layout preflight and its page. */
const readPage = cache(async function readPage<Data>(descriptor: ScreenDescriptor<Data>, serialized: string): Promise<Data> {
  const params = JSON.parse(serialized) as ScreenParams;
  const query = params.searchParams;
  if (!screenEnabled(descriptor)) notFound();
  // Presets are checked before Grid can fall back from an unsupported entity.
  if (descriptor.id === 'grid') {
    const { SCREEN_REGISTRY } = await import('../screens/registry-metadata');
    const entity = query['entity'];
    const preset = SCREEN_REGISTRY.find((screen) => screen.route === 'preset'
      && screen.path === `/grid?entity=${typeof entity === 'string' ? entity : ''}`);
    if (preset !== undefined && !screenEnabled(preset)) notFound();
  }
  let entry: PageEntry = { state: 'no-database' };
  let resolvedActor: OrgActor | undefined;
  let failure: unknown;
  const message = descriptor.entry === 'gate-message' || descriptor.entry === 'account-security';
  if (message) {
    entry = await messageEntry(descriptor, query);
    if (entry.state === 'ok') resolvedActor = { orgId: entry.context.active?.orgId ?? '', userId: entry.context.user.id };
  } else if (descriptor.entry !== 'redirect' && descriptor.entry !== 'feedback-bridge') {
    try {
      resolvedActor = await requestActor(await headers());
    } catch (error) {
      const destination = authenticationDestination(error);
      if (destination !== null) redirect(destination);
      failure = error;
    }
  }
  const requested = typeof query['profile'] === 'string' ? query['profile'] : query['profile']?.[0];
  const preferredProfile = message || descriptor.guard?.canonicalProfile
    ? await requestedProfileId(requested) : requested;
  const actor = (): OrgActor => {
    if (failure !== undefined) throw failure;
    if (resolvedActor === undefined) throw new RequestAuthError('Resource not found', 403);
    return resolvedActor;
  };
  const read = async <T>(run: (handle: QueryHandle, identity: OrgActor) => Promise<T>): Promise<T> => {
    // The fragment bridge authenticates only when it has a valid server-side id.
    if (descriptor.entry === 'feedback-bridge' && resolvedActor === undefined) resolvedActor = await requestActor(await headers());
    const identity = actor();
    // Gate-style entry already owns a process pool. Reuse it as gate() did;
    // opening another pool here adds a connection handshake to every page read.
    // Each operation still establishes current membership and transaction-local
    // RLS. Never close this process-owned handle or retain its transaction.
    if (entry.state === 'ok') {
      return withAuthenticatedActor(entry.handle, identity, (sql) => run({ sql }, identity));
    }
    const connection = openWebDatabase();
    try {
      return await withAuthenticatedActor(connection, identity, (sql) => run({ sql }, identity));
    } finally {
      await connection.close();
    }
  };
  const access: ScreenActor = {
    entry,
    requestedProfile: preferredProfile,
    actor,
    read,
    readSql: (run) => read(({ sql }) => run(sql)),
    readNullable: async (run) => {
      try { return await read(run); }
      catch (error) { if (isDatabaseUnreachable(error)) return null; throw error; }
    },
    snapshot: async (run) => {
      const identity = actor();
      const connection = openWebDatabase();
      try { return await withAuthenticatedReadSnapshot(connection, identity, run); }
      finally { await connection.close(); }
    },
    selectProfile: (profiles, preference = preferredProfile) => {
      const profile = resolveActiveProfile(profiles, preference);
      if (profile !== null && descriptor.guard?.kind === 'requested' && descriptor.guard.canonicalProfile) {
        const canonical = canonicalProfilePath(descriptor.path, query, profile.id);
        if (canonical !== null) redirect(canonical);
      }
      return profile;
    },
  };
  return descriptor.load(access, params);
});
