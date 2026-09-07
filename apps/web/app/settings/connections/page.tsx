/** Agency connections and persisted worker progress. URL parameters never supply result counts. */
import type { ReactNode } from 'react';
import { latestAmazonConnection, readAmazonConnection, withAuthenticatedActor } from '@wizard-ads/db';
import { Uuid } from '@wizard-ads/shared';
import { amazonConnectionsEnabled } from '../../../src/env';
import { ConnectionProgress } from '../../../src/oauth/connection-progress';
import { can } from '../../../src/auth/roles';
import { gate } from '../../../src/auth/guard';
import { listConnections } from '../../../src/data/connections';
import { loadRoster } from '../../../src/data/profiles';
import { operatorFailureLabel } from '../../../src/security/operator-failure';
import { Shell } from '../../../src/ui/shell';
import { banner, heading, muted, page, subheading, table, td, th } from '../../../src/ui/tokens';

export const dynamic = 'force-dynamic';

interface Props {
  searchParams: Promise<{
    org?: string;
    operation?: string;
    oauth_error?: string;
  }>;
}

export default async function ConnectionsPage({ searchParams }: Props): Promise<ReactNode> {
  const query = await searchParams;
  const result = await gate(query.org);

  if (result.state === 'no-database') {
    return (
      <main style={page}>
        <h1 style={heading}>Connections</h1>
        <p style={banner('warn')}>
          <code>DATABASE_URL</code> is not set, so this instance cannot read its own database.
        </p>
      </main>
    );
  }
  if (result.state === 'no-org') {
    return (
      <main style={page}>
        <h1 style={heading}>Connections</h1>
        <p style={banner('warn')}>
          Your account is not a member of any organisation yet. There is no self-service
          signup; ask an administrator to add you.
        </p>
      </main>
    );
  }

  const { handle, context } = result;
  const org = context.active;
  if (!org) return null;

  const actor = { orgId: org.orgId, userId: context.user.id };
  const enabled = amazonConnectionsEnabled();
  const [{ connections, roster }, operation] = await Promise.all([
    withAuthenticatedActor(handle, actor, async (sql) => ({
      connections: await listConnections({ sql }, org.orgId),
      roster: await loadRoster({ sql }, org.orgId),
    })),
    enabled ? (query.operation !== undefined
      ? Uuid.safeParse(query.operation).success ? readAmazonConnection(handle, actor, query.operation) : null
      : latestAmazonConnection(handle, actor)) : null,
  ]);
  const inProgress = operation !== null && ['awaiting_consent','queued','exchanging','discovering'].includes(operation.state);
  const mayConnect = can(org.role, 'manageConnection');
  const connected = connections.some((connection) => connection.status === 'active');

  return (
    <main style={page}>
      <Shell context={context} current="connections">
        <h1 style={heading}>Connections</h1>
        <p style={muted}>
          Connect an Amazon Ads account for this agency, then choose which profiles to synchronize.
          Only members of this agency can access its profiles.
        </p>

        {query.oauth_error ? (
          <p style={banner('bad')} data-testid="oauth-error">
            {operatorFailureLabel(query.oauth_error)}
          </p>
        ) : null}

        {operation ? <ConnectionProgress key={operation.operationId} initial={operation} mayCancel={mayConnect} /> : null}
        {enabled && query.operation && !operation ? <p style={banner('warn')}>This connection is not available in the selected agency.</p> : null}

        <h2 style={subheading}>Amazon Ads</h2>
        {connections.length === 0 ? (
          <p style={muted} data-testid="no-connection">
            Not connected yet.
          </p>
        ) : (
          <table style={table}>
            <thead>
              <tr>
                <th style={th}>Label</th>
                <th style={th}>Status</th>
                <th style={th}>Authorization</th>
                <th style={th}>Profiles</th>
                <th style={th}>Connected</th>
                <th style={th}>Last error</th>
              </tr>
            </thead>
            <tbody>
              {connections.map((connection) => (
                <tr key={connection.id} data-testid="connection-row">
                  <td style={td}>{connection.label}</td>
                  <td style={td} data-testid="connection-status">
                    {connection.status}
                  </td>
                  <td style={td}>{connection.hasCredential ? 'Stored' : 'Missing'}</td>
                  <td style={td}>{connection.profileCount}</td>
                  <td style={td}>{connection.connectedAt ?? '—'}</td>
                  <td style={td}>{connection.lastError ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <p style={{ marginTop: '1rem' }}>
          {mayConnect && enabled && !inProgress ? (
            <a href={`/api/amazon/oauth/start?${new URLSearchParams({ org: org.orgId })}`} data-testid="connect-amazon">
              {connected ? 'Reconnect Amazon Ads' : 'Connect Amazon Ads'}
            </a>
          ) : (
            <span style={muted} data-testid="connect-forbidden">
              {!mayConnect ? 'Connecting Amazon Ads requires the admin or owner role.'
                : !enabled ? 'Amazon connections are temporarily unavailable. Contact your installation operator.'
                  : 'A connection is already in progress. Finish or cancel it before starting another.'}
            </span>
          )}
        </p>

        <h2 style={subheading}>More connections</h2>
        <p style={muted}>
          Additional Amazon integrations are planned.
        </p>
        <div className="wa-row" style={{ gap: '0.5rem', marginTop: '0.5rem' }}>
          <button
            type="button"
            className="wa-btn wa-btn--sm"
            aria-disabled="true"
            disabled
            data-testid="connect-amc"
            title="Amazon Marketing Cloud — coming soon"
          >
            Connect AMC
            <span className="wa-badge" style={{ marginLeft: '0.375rem' }}>
              Coming soon
            </span>
          </button>
          <button
            type="button"
            className="wa-btn wa-btn--sm"
            aria-disabled="true"
            disabled
            data-testid="connect-spapi"
            title="Seller / Vendor Central (SP-API) — coming soon"
          >
            Connect Seller / Vendor Central
            <span className="wa-badge" style={{ marginLeft: '0.375rem' }}>
              Coming soon
            </span>
          </button>
        </div>

        <h2 style={subheading}>Profiles by region</h2>
        {roster.total === 0 ? (
          <p style={muted}>No profiles yet.</p>
        ) : (
          <p style={muted} data-testid="region-summary">
            {Object.entries(roster.regionCounts)
              .map(([region, count]) => `${region}: ${count}`)
              .join(' · ')}{' '}
            · total {roster.total}
          </p>
        )}
      </Shell>
    </main>
  );
}
