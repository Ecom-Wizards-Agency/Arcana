import { formatTimestamp } from '../../ui/date-format';
import { TableFrame } from '../../ui/primitives';
import { ScreenSurface, EmptyState as ScreenState } from '@wizard-ads/ui';
import { ConnectionProgress } from '../../oauth/connection-progress';
import { SpApiConnections } from '../../oauth/spapi-connections';

import { operatorFailureLabel } from '../../security/operator-failure';

import { Shell } from '../settings/frame';

import { banner, heading, muted, page, subheading, table, td, th } from '../../ui/tokens';

import type { load } from './load';

export type ScreenData = Awaited<ReturnType<typeof load>>;

function ScreenContent({ data }: { data: ScreenData; }) {
  if (data === null) return null;
  switch (data.view) {
    case 'no-database': return renderNoDatabase(data.props);
    case 'no-org': return renderNoOrg(data.props);
    case 'ready': return renderReady(data.props);
  }
}

function renderNoDatabase(_props: Extract<ScreenData, { view: 'no-database'; }>['props']) {
  return (<main style={page}>
    <h1 style={heading}>Connections</h1>
    <ScreenState variant="gated" title="Access unavailable" body={<>
      <code>DATABASE_URL</code> is not set, so this instance cannot read its own database.
    </>} />
  </main>);
}

function renderNoOrg(_props: Extract<ScreenData, { view: 'no-org'; }>['props']) {
  return (<main style={page}>
    <h1 style={heading}>Connections</h1>
    <ScreenState variant="gated" title="Access unavailable" body={<>
      Your account is not a member of any organisation yet. There is no self-service
      signup; ask an administrator to add you.
    </>} />
  </main>);
}

function renderReady({ context, query, operation, mayConnect, enabled, connections, inProgress, org, connected, roster, spApi, spApiEnabled, spApiOperation }: Extract<ScreenData, { view: 'ready'; }>['props']) {
  return (<main style={page}>
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
      {enabled && query.operation && !operation ? <ScreenState variant="gated" title="Access unavailable" body={<>This connection is not available in the selected agency.</>} /> : null}

      <h2 style={subheading}>Amazon Ads</h2>
      {connections.length === 0 ? (
        <ScreenState title="Not connected yet." body="Connect Amazon Ads to discover profiles." data-testid="no-connection" />
      ) : (
        <TableFrame><table style={table}>
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
                <td style={td}>{formatTimestamp(connection.connectedAt)}</td>
                <td style={td}>{connection.lastError ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table></TableFrame>
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

      <SpApiConnections key={org.orgId} orgId={org.orgId} mayManage={mayConnect} enabled={spApiEnabled}
        connections={spApi.connections} profiles={spApi.profiles} bindings={spApi.bindings} initial={spApiOperation} callbackError={query.spapi_error ?? null} startDetail={query.spapi_detail ?? null} />

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
      </div>

      <h2 style={subheading}>Profiles by region</h2>
      {roster.total === 0 ? (
        <ScreenState title="No profiles yet." body="Choose a connected profile or check again after the next sync." />
      ) : (
        <p style={muted} data-testid="region-summary">
          {Object.entries(roster.regionCounts)
            .map(([region, count]) => `${region}: ${count}`)
            .join(' · ')}{' '}
          · total {roster.total}
        </p>
      )}
    </Shell>
  </main>);
}

export default function ScreenView({ data }: { data: ScreenData }) {
  if (data === null) return null;
  return <ScreenSurface title="Connections">{ScreenContent({ data })}</ScreenSurface>;
}
