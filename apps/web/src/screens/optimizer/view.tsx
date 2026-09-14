import type { CSSProperties } from 'react';

import { tokens } from '@wizard-ads/ui';

import { gateMessage } from '../../ui/gate-message';

import { EmptyState, PageHeader } from '../../ui/primitives';

import { FreshnessBar } from '../../ui/dashboard';

import { OperatorContext } from '../../ui/operator-context';

import { Cockpit } from '../../ui/cockpit';

import { oneTimePreviewUnavailableMessage } from '../../optimizer/readiness';

import { todayIsoInTimeZone } from '../../../app/_lib/periods';

import { OptimizerGroupTable, ReasonCoverageRow, SettingsChip } from '../../../app/optimizer/optimizer-view';

import { CampaignWorkspace } from '../../../app/optimizer/campaign-workspace';

import type { load } from './load';

export type ScreenData = Awaited<ReturnType<typeof load>>;

export default function ScreenView({ data }: { data: ScreenData; }) {
  switch (data.view) {
    case 'gated': return renderGated(data.props);
    case 'empty': return renderEmpty(data.props);
    case 'ready': return renderReady(data.props);
  }
}

function renderGated({ entry }: Extract<ScreenData, { view: 'gated'; }>['props']) {
  return (<main style={page}>
    <PageHeader title="Campaign Optimizer" />
    <p className="wa-page-sub">{gateMessage(entry.state)}</p>
  </main>);
}

function renderEmpty(_props: Extract<ScreenData, { view: 'empty'; }>['props']) {
  return (<main style={page}>
    <PageHeader title="Campaign Optimizer" />
    <EmptyState
      title="No profiles yet"
      body="This organisation has no advertising profiles. Connect Amazon Ads and the roster lands on the next OAuth callback; the optimizer fills itself from the first recommendation run."
      action={
        <a className="wa-btn wa-btn--sm" href="/settings/connections">
          Connect Amazon Ads
        </a>
      }
    />
  </main>);
}

function renderReady({ run, summary, profile, period, today, params, freshness, runs, cockpitDays, tiles, settled, coverageStart, campaignRows, mayRunOptimizer, previewReadiness, coverage, proposals, campaignGroups }: Extract<ScreenData, { view: 'ready'; }>['props']) {
  return (<main style={page}>
    <PageHeader
      title="Campaign Optimizer"
      subtitle="Campaign performance, group context, and read-only recommendation previews"
      actions={
        <div className="wa-row" style={{ gap: '0.5rem' }}>
          {run?.executionSnapshot ? <span className="wa-pill">One-time RPC</span> : <SettingsChip summary={summary} group={run?.groupSnapshot} />}
          <a
            className="wa-btn wa-btn--sm"
            href={`/recommendations?profile=${profile.id}${run === null ? '' : `&run=${run.id}`}`}
          >
            Open review →
          </a>
        </div>
      }
    />

    <div className="wa-stack">
      <OperatorContext
        account={profile.label}
        marketplace={profile.countryCode}
        currencyCode={profile.currencyCode}
        timezone={profile.timezone}
        path="/optimizer"
        period={period}
        today={today}
        selectedPresetId={params.preset}
        preserved={{
          profile: profile.id,
          ...(run === null ? {} : { run: run.id }),
          batch: params.batch,
          preset: params.preset,
        }}
      />

      <FreshnessBar assessment={freshness} />

      {run?.executionSnapshot ? (
        <p className="wa-page-sub">
          One-time RPC · target ACOS {run.executionSnapshot.configuration.targetAcos * 100}% · bids {run.executionSnapshot.configuration.bidFloor}–{run.executionSnapshot.configuration.bidCeiling} {profile.currencyCode} · maximum increase {run.executionSnapshot.configuration.bidIncreaseCap * 100}% / decrease {run.executionSnapshot.configuration.bidDecreaseCap * 100}% · {run.executionSnapshot.configuration.window.start} to {run.executionSnapshot.configuration.window.end} ({run.executionSnapshot.profileTimezone}).
        </p>
      ) : null}

      {runs.length > 1 ? (
        <details className="wa-run-history">
          <summary>
            <span aria-hidden="true" className="wa-run-history__icon">↺</span>
            <span className="wa-run-history__label">Run history</span>
            <span className="wa-run-history__meta">
              {run?.executionSnapshot ? 'One-time RPC' : run?.groupSnapshot?.name ?? 'Legacy profile run'}
            </span>
            <span className="wa-run-history__status" data-status={run?.status ?? 'none'}>
              {formatRunStatus(run?.status ?? 'none')}
            </span>
            <span className="wa-run-history__count">{runs.length} runs</span>
          </summary>
          <nav className="wa-row" aria-label="Optimizer runs" style={{ marginTop: '0.625rem' }}>
            {runs.slice(0, 20).map((candidate) => (
              <a
                className={`wa-pill ${candidate.id === run?.id ? 'wa-pill--reason' : ''}`}
                href={`/optimizer?profile=${profile.id}&run=${candidate.id}&from=${period.start}&to=${period.end}`}
                key={candidate.id}
                aria-current={candidate.id === run?.id ? 'page' : undefined}
              >
                {candidate.executionSnapshot ? 'One-time RPC' : candidate.groupSnapshot?.name ?? 'Legacy profile'} · {candidate.createdAt.toISOString().slice(0, 10)} · {candidate.status === 'succeeded' ? `${candidate.proposalsCount} proposals` : candidate.status}
              </a>
            ))}
          </nav>
        </details>
      ) : null}

      <Cockpit
        days={cockpitDays}
        tiles={tiles}
        currencyCode={profile.currencyCode}
        settlingStart={settled.settling.start}
        coverageStart={coverageStart}
        preferenceKey={profile.id}
      />

      <CampaignWorkspace
        key={profile.id}
        rows={campaignRows}
        currencyCode={profile.currencyCode}
        profileId={profile.id}
        period={period}
        run={run === null ? null : { id: run.id, status: run.status }}
        mayRunOptimizer={mayRunOptimizer}
        previewReady={previewReadiness.ready}
        previewUnavailableMessage={previewReadiness.ready ? undefined : oneTimePreviewUnavailableMessage(previewReadiness.reason)}
        profileToday={todayIsoInTimeZone(profile.timezone)}
        profileTimezone={profile.timezone}
        initialBatchId={params.batch ?? null}
      />

      {run === null ? (
        <p className="wa-page-sub">No recommendation preview has run yet. Campaigns remain visible above; choose settings above to queue a one-time preview.</p>
      ) : run.status !== 'succeeded' ? (
        <p className="wa-page-sub" role="status">
          {run.status === 'queued'
            ? run.executionSnapshot ? 'One-time preview queued with the confirmed settings and reporting dates.' : 'Recommendation preview queued. It will use the last complete profile-local evidence window.'
            : run.status === 'running'
              ? run.executionSnapshot ? 'One-time preview is checking reporting facts and safeguards with the confirmed settings.' : 'Recommendation preview is assembling facts, strategy, pacing, and bid corridors.'
              : 'The recommendation preview failed. Campaign performance above remains available; check Sync status before retrying.'}
        </p>
      ) : (
        <>
          <ReasonCoverageRow coverage={coverage} total={proposals.length} />

          {campaignGroups.length === 0 ? null : (
            <section aria-label="Campaign drill-down" className="wa-stack">
              <h2 className="wa-section-title" style={{ margin: 0 }}>
                {run.executionSnapshot ? 'One-time campaign drill-down' : run.groupSnapshot ? `${run.groupSnapshot.name} campaign drill-down` : 'Legacy campaign drill-down'} · {campaignGroups.length}
              </h2>
              {campaignGroups.map((group) => (
                <OptimizerGroupTable
                  key={group.key}
                  group={group}
                  bidHistoryContext={{
                    profileId: profile.id,
                    window: period,
                    currencyCode: profile.currencyCode,
                  }}
                />
              ))}
            </section>
          )}

          <p className="wa-page-sub">
            {run.executionSnapshot ? 'To inspect and review these proposals, open the ' : 'To review rows, edit values, and stage an export, open the '}
            <a href={`/recommendations?profile=${profile.id}&run=${run.id}`}>full review →</a>
          </p>
        </>
      )}
    </div>
  </main>);
}

function formatRunStatus(status: string): string {
  return status.replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase());
}

/**
 * Full width, not the shared 84rem reading column.
 *
 * The campaign table is the surface the operator compared against AdLabs, and
 * a centred column was the first thing named: fifteen columns and a group bar
 * want every pixel the frame gives them. Same declaration as `/grid`.
 */
const page: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: tokens.space(4),
  minWidth: 0,
  width: '100%',
};
