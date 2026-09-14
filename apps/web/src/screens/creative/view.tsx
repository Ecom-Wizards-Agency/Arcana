import { Suspense } from 'react';

import { gateMessage } from '../../ui/gate-message';

import { Badge, EmptyState, PageHeader } from '../../ui/primitives';

import { OperatorContext } from '../../ui/operator-context';

import { page } from '../../ui/tokens';

import styles from '../../../app/creative/creative.module.css';

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
    <PageHeader title="Creative Performance" />
    <p className="wa-page-sub">{gateMessage(entry.state)}</p>
  </main>);
}

function renderEmpty(_props: Extract<ScreenData, { view: 'empty'; }>['props']) {
  return (<main style={page}>
    <PageHeader
      title="Creative Performance"
      subtitle="Sponsored Brands Video · current observed Amazon Asset ID mappings"
    />
    <EmptyState
      title="No profiles yet"
      body="Connect Amazon Ads before loading creative performance."
      action={<a className="wa-btn wa-btn--sm" href="/settings/connections">Connect Amazon Ads</a>}
    />
  </main>);
}

function renderReady({ profile, period, profileToday, selectedPresetId, slot1, slot2 }: Extract<ScreenData, { view: 'ready'; }>['props']) {
  return (<main style={{ ...page, maxWidth: '96rem' }}>
    <PageHeader
      title="Creative Performance"
      subtitle="Sponsored Brands Video performance by authoritative Amazon Asset ID"
      meta={
        <>
          <Badge tone="info">Sponsored Brands Video · v1</Badge>
          <Badge>Identity · Amazon Asset ID</Badge>
        </>
      }
    />

    <OperatorContext
      account={profile.label}
      marketplace={profile.countryCode}
      currencyCode={profile.currencyCode}
      timezone={profile.timezone}
      path="/creative"
      period={period}
      today={profileToday}
      includeToday
      selectedPresetId={selectedPresetId}
      preserved={{ profile: profile.id, preset: selectedPresetId }}
    />

    <Suspense fallback={<CreativeLifecycleLoading />}>
      {slot1}
    </Suspense>

    <Suspense fallback={<CreativeResultsLoading />}>
      {slot2}
    </Suspense>
  </main>);
}

function CreativeLifecycleLoading() {
  return <div aria-hidden="true" className={styles.lifecycleLoading} />;
}

function CreativeResultsLoading() {
  return (
    <section aria-busy="true" aria-label="Creative performance loading">
      <div className={styles.loadingSummary}>
        {Array.from({ length: 4 }, (_, index) => <div key={index} />)}
      </div>
      <div className={styles.loadingTable} />
    </section>
  );
}
