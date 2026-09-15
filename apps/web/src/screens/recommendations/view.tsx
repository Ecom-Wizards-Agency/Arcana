import { ProviderEvidencePanel } from './provider-evidence';
import { ProviderDiagnostics } from './provider-diagnostics';
import { formatShellDate, formatTimestamp, formatDateWindow } from '../../ui/date-format';
import { ScreenSurface, EmptyState as ScreenState } from '@wizard-ads/ui';
import type { CSSProperties } from 'react';
import { EmptyState } from '../../ui/primitives';
import { RELEASE_ARTIFACT } from '../../ui/artifact-markers';
import { ReviewWorkspace } from '../../../app/recommendations/review';
import type { load } from './load';





export type ScreenData = Awaited<ReturnType<typeof load>>;

function ScreenContent({ data }: { data: ScreenData; }) {
  switch (data.view) {
    case 'empty': return renderEmpty(data.props);
    case 'ready': return renderReady(data.props);
    case 'error': return renderError(data.props);
  }
}

function renderEmpty(_props: Extract<ScreenData, { view: 'empty'; }>['props']) {
  return (<main
    style={main}
    data-release-artifact={RELEASE_ARTIFACT.recommendationReview}
  >
    <h1 style={heading}>Recommendations</h1>
    <EmptyState
      title="No profiles yet"
      body="This organisation has no advertising profiles, so there can be no recommendation run to review. Connect Amazon Ads to create the roster."
      action={
        <a className="wa-btn wa-btn--sm" href="/settings/connections">
          Connect Amazon Ads
        </a>
      }
    />
  </main>);
}

function renderReady({ run, proposals, profile, runs, role, providerEvidence, providerDiagnostics }: Extract<ScreenData, { view: 'ready'; }>['props']) {
  return (<main
    style={main}
    data-interactive="true"
    data-release-artifact={RELEASE_ARTIFACT.recommendationReview}
  >
    <ProviderEvidencePanel evidence={providerEvidence} consumer="recommendations" />
    <ProviderDiagnostics evidence={providerDiagnostics} />
    <header style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <div style={{ alignItems: 'center', display: 'flex', justifyContent: 'space-between' }}>
        <h1 style={heading}>Recommendations</h1>
        {run === null || proposals.length === 0 ? null : (
          <a className="wa-btn wa-btn--primary wa-btn--sm" href="#recommendation-review">
            Open review
          </a>
        )}
      </div>
      <p style={muted}>
        {profile.label} · {profile.currencyCode} ·{' '}
        {run === null
          ? 'no run selected'
          : run.finishedAt === null
            ? `run ${run.status}`
            : `${proposals.length} proposal${proposals.length === 1 ? '' : 's'} · ${run.windowStart !== null && run.windowEnd !== null ? formatDateWindow(run.windowStart, run.windowEnd) : 'Window unavailable'}`}
      </p>
      {run === null ? null : (
        <details className="wa-dashboard-context" style={{ marginTop: 0 }}>
          <summary>Run details</summary>
          <p>
            Engine {run.engineVersion ?? 'unversioned'} · status {run.status} · created{' '}
            {formatTimestamp(run.createdAt)}
            {run.executionSnapshot ? ' · one-time RPC preview' : run.groupSnapshot ? ` · group ${run.groupSnapshot.name} (${run.groupSnapshot.role})` : ' · legacy profile run'}
          </p>
          {run.executionSnapshot ? <p>Confirmed target ACOS {run.executionSnapshot.configuration.targetAcos * 100}% · bids {run.executionSnapshot.configuration.bidFloor}–{run.executionSnapshot.configuration.bidCeiling} {profile.currencyCode} · maximum increase {run.executionSnapshot.configuration.bidIncreaseCap * 100}% / decrease {run.executionSnapshot.configuration.bidDecreaseCap * 100}% · {formatDateWindow(run.executionSnapshot.configuration.window.start, run.executionSnapshot.configuration.window.end)} ({run.executionSnapshot.profileTimezone}).</p> : null}
        </details>
      )}
      {runs.length > 1 ? (
        <details className="wa-dashboard-context" style={{ marginTop: 0 }}>
          <summary>Choose run · {run?.executionSnapshot ? 'One-time RPC' : run?.groupSnapshot?.name ?? 'Legacy profile run'}</summary>
          <nav style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.5rem' }} aria-label="Runs">
            {runs.map((option) => (
              <a
                key={option.id}
                href={`/recommendations?profile=${profile.id}&run=${option.id}`}
                style={{ ...pill, fontWeight: option.id === run?.id ? 600 : 400 }}
              >
                {option.executionSnapshot ? 'One-time RPC' : option.groupSnapshot?.name ?? 'Legacy profile'} · {formatShellDate(option.createdAt.toISOString().slice(0, 10))} ·{' '}
                {option.finishedAt === null ? option.status : option.proposalsCount}
              </a>
            ))}
          </nav>
        </details>
      ) : null}
    </header>

    {run === null ? (
      <EmptyState variant="not-measured"
        title="No recommendations run yet"
        body="The weekly engine has not finished a run for this profile, so there is nothing to review yet. The optimizer shows the current facts and when the next run can start."
        action={
          <a className="wa-btn wa-btn--sm" href={`/optimizer?profile=${profile.id}`}>
            Open optimizer
          </a>
        }
      />
    ) : run.finishedAt === null ? (
      <EmptyState variant="loading"
        title={run.status === 'running' ? 'Recommendations run in progress' : 'Recommendations run queued'}
        body={
          run.status === 'running'
            ? run.executionSnapshot ? 'The worker is checking reporting facts and safeguards with your confirmed RPC settings.' : 'The worker is assembling facts, doctrine, pacing, and bid corridors now. Refresh shortly to see the preview.'
            : run.executionSnapshot ? 'The preview is queued with your confirmed settings and fixed reporting dates.' : "The preview is in the worker queue. It will use the last complete seven-day window in this profile's timezone."
        }
      />
    ) : run.status !== 'succeeded' ? (
      <EmptyState variant="error"
        title="Recommendations run failed"
        body="The worker recorded this run as failed. Queue a new preview after checking sync freshness and strategy settings."
      />
    ) : proposals.length === 0 ? (
      <EmptyState
        title="This run proposed nothing"
        body="The engine found no change worth proposing for this profile in this window. On a healthy account that can be the expected result."
        meta={
          <time dateTime={run.createdAt.toISOString()}>
            Run created {formatTimestamp(run.createdAt)}
          </time>
        }
        action={
          <a className="wa-btn wa-btn--sm" href={`/optimizer?profile=${profile.id}`}>
            Open optimizer
          </a>
        }
      />
    ) : (
      <div id="recommendation-review">
        <ReviewWorkspace
          proposals={proposals}
          runId={run.id}
          profileId={profile.id}
          client={profile.label}
          currencyCode={profile.currencyCode}
          counts={run.counts}
          role={role}
          hasStrategySnapshot={run.strategySnapshot !== null}
          oneTimePreview={run.executionSnapshot !== undefined}
          exportDisabledReason={run.executionSnapshot === undefined ? undefined : 'One-time results are available for review. Export awaits observation support.'}
          runGroupName={run.groupSnapshot?.name}
        />
      </div>
    )}

    <p style={muted}>
      <a href={`/ngrams?profile=${profile.id}`}>N-gram explorer</a> ·{' '}
      <a href={`/grid?profile=${profile.id}`}>Grid</a>
    </p>
  </main>);
}

function renderError({ message }: Extract<ScreenData, { view: 'error'; }>['props']) {
  return (<main style={main}>
    <h1 style={heading}>Recommendations</h1>
    <ScreenState variant="error" title="Could not load this screen" body={message} />
  </main>);
}

/**
 * Full width, not a centred reading column.
 *
 * The queue is a twelve-column grid with a group bar; the same decision the
 * grid and the optimizer took, for the same reason the operator named when
 * comparing this application against AdLabs. The application frame
 * (`.wa-content`) already supplies the horizontal padding.
 */
const main: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  fontFamily: 'var(--wa-font)',
  gap: '1.5rem',
  minWidth: 0,
  width: '100%',
};

const heading: CSSProperties = { fontSize: '1.5rem', margin: 0 };

const muted: CSSProperties = { color: 'var(--wa-text-muted)', fontSize: '0.875rem', margin: 0 };

const pill: CSSProperties = {
  border: '1px solid var(--wa-border-strong)',
  borderRadius: '999px',
  color: 'var(--wa-text)',
  fontSize: '0.8125rem',
  padding: '0.125rem 0.625rem',
  textDecoration: 'none',
};

export default function ScreenView({ data }: { data: ScreenData }) {
  return <ScreenSurface title="Recommendations">{ScreenContent({ data })}</ScreenSurface>;
}
