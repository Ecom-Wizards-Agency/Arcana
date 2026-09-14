import { heading, muted, page } from '../../ui/tokens';

import { NewExperimentForm } from '../../../app/experiments/new/form';

import type { load } from './load';

export type ScreenData = Awaited<ReturnType<typeof load>>;

export default function ScreenView({ data }: { data: ScreenData; }) {
  switch (data.view) {
    case 'ready': return renderReady(data.props);
    case 'error': return renderError(data.props);
  }
}

function renderReady({ profiles, selectedProfileId, query, scope, scopeOptions }: Extract<ScreenData, { view: 'ready'; }>['props']) {
  return (<NewExperimentForm
    profiles={profiles}
    selectedProfileId={selectedProfileId}
    prefillName={single(query['name']) ?? ''}
    scope={scope}
    initialScopeOptions={scopeOptions}
  />);
}

function renderError({ message }: Extract<ScreenData, { view: 'error'; }>['props']) {
  return (<main style={page}>
    <h1 style={heading}>New experiment</h1>
    <p role="alert">{message}</p>
    <p style={muted}>Nothing was filed; this is the form refusing to open.</p>
  </main>);
}

const single = (value: string | string[] | undefined): string | null =>
  typeof value === 'string' ? value : null;
