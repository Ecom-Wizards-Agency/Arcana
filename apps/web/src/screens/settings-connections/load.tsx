import type { ScreenActor } from '../../server/page-read';

import type { ScreenParams } from '../types';

/** Agency connections and persisted worker progress. URL parameters never supply result counts. */

import { latestAmazonConnection, readAmazonConnection } from '@wizard-ads/db';

import { Uuid } from '@wizard-ads/shared';

import { amazonConnectionsEnabled } from '../../env';

import { can } from '../../auth/roles';

import { listConnections } from '../../data/connections';

import { loadRoster } from '../../data/profiles';

interface Props {
  searchParams: Promise<{
    org?: string;
    operation?: string;
    oauth_error?: string;
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
  const [{ connections, roster }, operation] = await Promise.all([
    access.readSql(async (sql) => ({
      connections: await listConnections({ sql }, org.orgId),
      roster: await loadRoster({ sql }, org.orgId),
    })),
    enabled ? (query.operation !== undefined
      ? Uuid.safeParse(query.operation).success ? readAmazonConnection(handle, actor, query.operation) : null
      : latestAmazonConnection(handle, actor)) : null,
  ]);
  const inProgress = operation !== null && ['awaiting_consent', 'queued', 'exchanging', 'discovering'].includes(operation.state);
  const mayConnect = can(org.role, 'manageConnection');
  const connected = connections.some((connection) => connection.status === 'active');

  return { view: 'ready' as const, props: { context, query, operation, mayConnect, enabled, connections, inProgress, org, connected, roster } };
}
