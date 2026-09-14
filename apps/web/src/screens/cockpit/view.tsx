import { Suspense } from 'react';

import { gateMessage } from '../../ui/gate-message';

import { Card, EmptyState, PageHeader } from '../../ui/primitives';

import { FreshnessBar, PacingCard } from '../../ui/dashboard';

import { Cockpit } from '../../ui/cockpit';

import type { PacingView } from '../../ui/dashboard';

import { page } from '../../ui/tokens';

import { OperatorContext } from '../../ui/operator-context';

import type { load } from './load';

export type ScreenData = Awaited<ReturnType<typeof load>>;

export default function ScreenView({ data }: { data: ScreenData; }) {
  switch (data.view) {
    case 'gated': return renderGated(data.props);
    case 'no-database': return renderNoDatabase(data.props);
    case 'empty': return renderEmpty(data.props);
    case 'ready': return renderReady(data.props);
  }
}

function renderGated({ entry }: Extract<ScreenData, { view: 'gated'; }>['props']) {
  return (<main style={page}>
    <PageHeader title="Dashboard" />
    <p className="wa-page-sub">{gateMessage(entry.state)}</p>
  </main>);
}

function renderNoDatabase(_props: Extract<ScreenData, { view: 'no-database'; }>['props']) {
  return (<main style={page}>
    <PageHeader title="Dashboard" />
    <p className="wa-page-sub">{gateMessage('no-database')}</p>
  </main>);
}

function renderEmpty(_props: Extract<ScreenData, { view: 'empty'; }>['props']) {
  return (<main style={page}>
    <PageHeader title="Dashboard" />
    <EmptyState
      title="No profiles yet"
      body="This organisation has no advertising profiles. Connect Amazon Ads and the roster lands on the next OAuth callback; the dashboard fills itself from the first sync."
      action={
        <a className="wa-btn wa-btn--sm" href="/settings/connections">
          Connect Amazon Ads
        </a>
      }
    />
  </main>);
}

function renderReady({ profile, period, today, currentWindow, settled, coverageClamped, freshness, slot1, cockpitDays, tiles, settlingWindow, accountRows, pacing, context, slot2, slot3 }: Extract<ScreenData, { view: 'ready'; }>['props']) {
  return (<main style={page}>
    <PageHeader
      title="Dashboard"
      subtitle="Performance, operating constraints, and the next decisions that need attention"
    />

    <div className="wa-stack">
      <OperatorContext
        account={profile.label}
        marketplace={profile.countryCode}
        currencyCode={profile.currencyCode}
        timezone={profile.timezone}
        path="/"
        period={period}
        today={today}
        preserved={{ profile: profile.id }}
      />
      <details className="wa-dashboard-context">
        <summary>Comparison and attribution coverage</summary>
        <p>
          {currentWindow === null || settled.comparison === null
            ? 'No settled KPI comparison is available yet.'
            : `Settled KPIs use ${currentWindow.start} to ${currentWindow.end}${coverageClamped ? ' from the first synced day' : ''}, compared with ${settled.comparison.start} to ${settled.comparison.end}.`}
          {' '}Recent conversion days remain in the chart and are marked as settling.
        </p>
      </details>

      <FreshnessBar assessment={freshness}>
        <Suspense fallback={null}>
          {slot1}
        </Suspense>
      </FreshnessBar>

      <Cockpit
        days={cockpitDays}
        tiles={tiles}
        currencyCode={profile.currencyCode}
        settlingStart={settlingWindow.start}
        coverageStart={accountRows[0]?.date ?? null}
        preferenceKey={profile.id}
      />

      <section className="wa-grid-2">
        <PacingCard pacing={pacing as PacingView | null} context={context} />
        <Suspense fallback={<OperatingStatusLoading />}>
          {slot2}
        </Suspense>
      </section>

      <Suspense fallback={<CampaignInsightsLoading />}>
        {slot3}
      </Suspense>

    </div>
  </main>);
}

function CampaignInsightsLoading() {
  return (
    <Card title="Campaign signals" subtitle="Loading campaign-level alerts and spend concentration…">
      <div className="wa-operating-status" aria-busy="true" aria-label="Campaign signals loading">
        {['Alert groups', 'Spend concentration', 'Campaign coverage'].map((label) => (
          <div className="wa-operating-signal" key={label}>
            <span>{label}</span>
            <strong>—</strong>
          </div>
        ))}
      </div>
    </Card>
  );
}

function OperatingStatusLoading() {
  return (
    <Card title="Operating status" subtitle="Loading account constraints and decision evidence…">
      <div className="wa-operating-status" aria-busy="true">
        {['Stock gate', 'Optimization groups', 'Open export batch', 'Evidence loop'].map((label) => (
          <div className="wa-operating-signal" key={label}><span>{label}</span><strong>—</strong></div>
        ))}
      </div>
    </Card>
  );
}
