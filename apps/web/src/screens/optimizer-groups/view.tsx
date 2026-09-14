import { can } from '../../auth/roles';

import { gateMessage } from '../../ui/gate-message';

import { EmptyState, PageHeader } from '../../ui/primitives';

import { page } from '../../ui/tokens';

import { OptimizationGroupsManager } from '../../../app/optimizer/groups/groups-manager';

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
    <PageHeader title="Optimization Groups" />
    <p className="wa-page-sub">{gateMessage(entry.state)}</p>
  </main>);
}

function renderEmpty(_props: Extract<ScreenData, { view: 'empty'; }>['props']) {
  return (<main style={page}>
    <PageHeader title="Optimization Groups" />
    <EmptyState
      title="No profiles yet"
      body="Connect Amazon Ads before assigning campaigns to optimization groups."
      action={<a className="wa-btn wa-btn--sm" href="/settings/connections">Connect Amazon Ads</a>}
    />
  </main>);
}

function renderReady({ profile, workspace, context, previewReadiness }: Extract<ScreenData, { view: 'ready'; }>['props']) {
  return (<main style={page}>
    <PageHeader
      title="Optimization Groups"
      subtitle={`${profile.label} · one policy and local review schedule per campaign`}
      actions={<a className="wa-btn wa-btn--sm" href={`/optimizer?profile=${profile.id}`}>Open optimizer →</a>}
    />
    <OptimizationGroupsManager
      profileId={profile.id}
      initial={workspace}
      canManage={can(context.active?.role, 'editTargets')}
      previewReady={previewReadiness.ready}
    />
  </main>);
}
