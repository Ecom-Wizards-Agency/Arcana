import { can } from '../../auth/roles';

import { heading, muted, page } from '../../ui/tokens';

import { toUiExperiment } from '../../experiments/ui';

import { ExperimentsList } from '../../../app/experiments/list';

import type { load } from './load';

export type ScreenData = Awaited<ReturnType<typeof load>>;

export default function ScreenView({ data }: { data: ScreenData; }) {
  switch (data.view) {
    case 'ready': return renderReady(data.props);
    case 'error': return renderError(data.props);
  }
}

function renderReady({ items, profiles, selectedProfileId, proposedTests, role }: Extract<ScreenData, { view: 'ready'; }>['props']) {
  return (<ExperimentsList
    items={items.map(toUiExperiment)}
    profiles={profiles}
    selectedProfileId={selectedProfileId}
    proposedTests={proposedTests}
    canManage={can(role, 'manageExperiments')}
    role={role}
  />);
}

function renderError({ message }: Extract<ScreenData, { view: 'error'; }>['props']) {
  return (<main style={page}>
    <h1 style={heading}>Experiments</h1>
    <p role="alert">{message}</p>
    <p style={muted}>Nothing was read; this is the tracker refusing, not an empty tracker.</p>
  </main>);
}
