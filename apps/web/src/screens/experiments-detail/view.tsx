import { heading, muted, page } from '../../ui/tokens';

import { ExperimentDetail } from '../../../app/experiments/[experimentId]/detail';

import type { load } from './load';

export type ScreenData = Awaited<ReturnType<typeof load>>;

export default function ScreenView({ data }: { data: ScreenData; }) {
  switch (data.view) {
    case 'error': return renderError(data.props);
    case 'ready': return renderReady(data.props);
  }
}

function renderError({ message }: Extract<ScreenData, { view: 'error'; }>['props']) {
  return (<main style={page}>
    <h1 style={heading}>Experiment</h1>
    <p role="alert">{message}</p>
    <p style={muted}>Nothing was read; this is the page refusing, not an empty experiment.</p>
  </main>);
}

function renderReady({ detail }: Extract<ScreenData, { view: 'ready'; }>['props']) {
  return (<ExperimentDetail {...detail} />);
}
