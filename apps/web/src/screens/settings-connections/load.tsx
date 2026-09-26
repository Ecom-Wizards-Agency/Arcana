import type { ScreenActor } from '../../server/page-read';

import type { ScreenParams } from '../types';

/** Agency connections and persisted worker progress. URL parameters never supply result counts. */

import { latestAmazonConnection, readAmazonConnection, latestSpApiConnection, createSpApiConnectionLifecycle, listSpApiProfileBindings } from '@wizard-ads/db';

import { Uuid, type Region } from '@wizard-ads/shared';

import { amazonConnectionsEnabled, spApiConnectionsEnabled, spApiOAuthConfig } from '../../env';

import { can } from '../../auth/roles';

import { listConnections, loadSpApiConnections } from '../../data/connections';

import { loadRoster } from '../../data/profiles';

interface Props {
  searchParams: Promise<{
    org?: string;
    operation?: string;
    oauth_error?: string;
    spapi_operation?: string;
    spapi_error?: string;
    spapi_detail?: string;
  }>;
}

export async function load(access: ScreenActor, input: ScreenParams) {
  const searchParams = Promise.resolve(input.searchParams) as Props['searchParams'];

  const query = await searchParams;
  const result = access.entry;

  if (result.state === 'no-database') {
    return { view: 'no-database' as const, props: {} };
  }
  if (result.state === 'no-org') {
    return { view: 'no-org' as const, props: {} };
  }

  const { handle, context } = result;
  const org = context.active;
  if (!org) return null;

  const actor = { orgId: org.orgId, userId: context.user.id };
  const enabled = amazonConnectionsEnabled();
  let spApiEnabled = false;
  let consentRegion: Region | null = null;
  try {
    if (spApiConnectionsEnabled()) { consentRegion = spApiOAuthConfig().region; spApiEnabled = true; }
  } catch { /* Fail closed. */ }
  const [{ connections, roster, spApi }, operation, spApiOperation] = await Promise.all([
    access.readSql(async (sql) => ({
      connections: await listConnections({ sql }, org.orgId),
      roster: await loadRoster({ sql }, org.orgId),
      spApi: { ...await loadSpApiConnections({ sql }, org.orgId, consentRegion), bindings: await listSpApiProfileBindings({ sql }, org.orgId) },
    })),
    enabled ? (query.operation !== undefined
      ? Uuid.safeParse(query.operation).success ? readAmazonConnection(handle, actor, query.operation) : null
      : latestAmazonConnection(handle, actor)) : null,
    query.spapi_operation !== undefined
      ? Uuid.safeParse(query.spapi_operation).success
        ? createSpApiConnectionLifecycle(handle).operation(actor, query.spapi_operation) : null
      : latestSpApiConnection(handle, actor),
  ]);
  const inProgress = operation !== null && ['awaiting_consent', 'queued', 'exchanging', 'discovering'].includes(operation.state);
  const mayConnect = can(org.role, 'manageConnection');
  const connected = connections.some((connection) => connection.status === 'active');

  return { view: 'ready' as const, props: { context, query, operation, mayConnect, enabled, connections, inProgress, org, connected, roster,
    spApi, spApiOperation, spApiEnabled } };
}
