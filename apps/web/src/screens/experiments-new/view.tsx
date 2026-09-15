import { ScreenSurface, EmptyState as ScreenState } from '@wizard-ads/ui';
import { heading, muted, page } from '../../ui/tokens';

import { NewExperimentForm } from '../../../app/experiments/new/form';

import type { load } from './load';

export type ScreenData = Awaited<ReturnType<typeof load>>;

function ScreenContent({ data }: { data: ScreenData; }) {
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
    <ScreenState variant="error" title="Could not load this screen" body={message} />
    <p style={muted}>Nothing was filed; this is the form refusing to open.</p>
  </main>);
}

const single = (value: string | string[] | undefined): string | null =>
  typeof value === 'string' ? value : null;

export default function ScreenView({ data }: { data: ScreenData }) {
  return <ScreenSurface title="New experiment">{ScreenContent({ data })}</ScreenSurface>;
}
