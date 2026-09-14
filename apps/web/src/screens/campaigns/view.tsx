import { PageHeader } from '../../ui/primitives';

import { CampaignBuilder } from '../../../app/campaigns/builder';

import type { load } from './load';

export type ScreenData = Awaited<ReturnType<typeof load>>;

export default function ScreenView({ data }: { data: ScreenData; }) {
  switch (data.view) {
    case 'ready': return renderReady(data.props);
    case 'error': return renderError(data.props);
  }
}

function renderReady({ profile, label, marketplace }: Extract<ScreenData, { view: 'ready'; }>['props']) {
  return (<main className="wa-page" data-interactive="true">
    <PageHeader
      title="Campaign Builder"
      subtitle="Plan new Sponsored Products campaigns or review changes against synced entities. Every workflow ends with a bulksheet for manual review and upload."
      meta={
        profile === null ? null : (
          <span className="wa-hint">
            Update source · {profile.label} · {profile.countryCode} · synced mirror
          </span>
        )
      }
    />
    <CampaignBuilder
      profileId={profile?.id ?? null}
      profileLabel={label}
      marketplace={marketplace}
    />
  </main>);
}

function renderError({ message }: Extract<ScreenData, { view: 'error'; }>['props']) {
  return (<main className="wa-page">
    <PageHeader title="Campaign Builder" />
    <p role="alert">{message}</p>
  </main>);
}
