import { ScreenSurface, EmptyState as ScreenState } from '@wizard-ads/ui';
import { heading, muted, page } from '../../ui/tokens';

import { SubmitFeedbackForm } from '../../../app/feedback/new/submit-form';

import type { load } from './load';

export type ScreenData = Awaited<ReturnType<typeof load>>;

function ScreenContent({ data }: { data: ScreenData; }) {
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
    <ScreenState variant="error" title="Could not load this screen" body={message} />
    <p style={muted}>Nothing was filed; this is the form refusing to open.</p>
  </main>);
}

export default function ScreenView({ data }: { data: ScreenData }) {
  return <ScreenSurface title="New feedback">{ScreenContent({ data })}</ScreenSurface>;
}
