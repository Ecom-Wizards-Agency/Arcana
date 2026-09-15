import { ScreenSurface } from '@wizard-ads/ui';
import { LegacyFeedbackRedirect } from '../../../app/feedback/legacy-redirect';

import type { load } from './load';

export type ScreenData = Awaited<ReturnType<typeof load>>;

function ScreenContent({ data }: { data: ScreenData; }) {
  switch (data.view) {
    case 'bridge': return renderBridge(data.props);
  }
}

function renderBridge(_props: Extract<ScreenData, { view: 'bridge'; }>['props']) {
  return (<LegacyFeedbackRedirect />);
}

export default function ScreenView({ data }: { data: ScreenData }) {
  return <ScreenSurface title="Feedback">{ScreenContent({ data })}</ScreenSurface>;
}
