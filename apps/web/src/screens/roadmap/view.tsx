import { ScreenSurface, EmptyState as ScreenState } from '@wizard-ads/ui';
import { can } from '../../auth/roles';

import { heading, muted, page } from '../../ui/tokens';

import { RoadmapBoardView } from '../../../app/roadmap/board';

import type { load } from './load';

export type ScreenData = Awaited<ReturnType<typeof load>>;

function ScreenContent({ data }: { data: ScreenData; }) {
  switch (data.view) {
    case 'ready': return renderReady(data.props);
    case 'error': return renderError(data.props);
  }
}

function renderReady({ actor, mapped, role }: Extract<ScreenData, { view: 'ready'; }>['props']) {
  return (<RoadmapBoardView
    key={`${actor.orgId}:${actor.userId}`}
    planned={mapped.filter((item) => ['planned', 'new', 'triaged'].includes(item.status))}
    inProgress={mapped.filter((item) => item.status === 'in_progress')}
    shipped={mapped.filter((item) => item.status === 'shipped')}
    declined={mapped.filter((item) => item.status === 'declined')}
    canTriage={can(role, 'triageFeedback')}
  />);
}

function renderError({ message }: Extract<ScreenData, { view: 'error'; }>['props']) {
  return (<main style={page}>
    <h1 style={heading}>Roadmap</h1>
    <ScreenState variant="error" title="Could not load this screen" body={message} />
    <p style={muted}>Nothing was read; this is the board refusing, not an empty board.</p>
  </main>);
}

export default function ScreenView({ data }: { data: ScreenData }) {
  return <ScreenSurface title="Roadmap">{ScreenContent({ data })}</ScreenSurface>;
}
