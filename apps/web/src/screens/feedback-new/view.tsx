import { heading, muted, page } from '../../ui/tokens';

import { SubmitFeedbackForm } from '../../../app/feedback/new/submit-form';

import type { load } from './load';

export type ScreenData = Awaited<ReturnType<typeof load>>;

export default function ScreenView({ data }: { data: ScreenData; }) {
  switch (data.view) {
    case 'ready': return renderReady(data.props);
    case 'error': return renderError(data.props);
  }
}

function renderReady({ context, preselectedType }: Extract<ScreenData, { view: 'ready'; }>['props']) {
  return (<SubmitFeedbackForm context={context} preselectedType={preselectedType} />);
}

function renderError({ message }: Extract<ScreenData, { view: 'error'; }>['props']) {
  return (<main style={page}>
    <h1 style={heading}>Submission form</h1>
    <p role="alert">{message}</p>
    <p style={muted}>Nothing was filed; this is the form refusing to open.</p>
  </main>);
}
