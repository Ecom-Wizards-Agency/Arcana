import { ScreenSurface, EmptyState as ScreenState } from '@wizard-ads/ui';
import { can } from '../../auth/roles';

import { heading, muted, page } from '../../ui/tokens';

import { BugBoardView } from '../../../app/bugs/board';

import type { load } from './load';

export type ScreenData = Awaited<ReturnType<typeof load>>;

function ScreenContent({ data }: { data: ScreenData; }) {
  switch (data.view) {
    case 'ready': return renderReady(data.props);
    case 'error': return renderError(data.props);
  }
}

function renderReady({ map, board, role }: Extract<ScreenData, { view: 'ready'; }>['props']) {
  return (<BugBoardView
    open={map(board.open)}
    inProgress={map(board.inProgress)}
    fixed={map(board.fixed)}
    declined={map(board.declined)}
    duplicates={map(board.duplicates)}
    canTriage={can(role, 'triageFeedback')}
  />);
}

function renderError({ message }: Extract<ScreenData, { view: 'error'; }>['props']) {
  return (<main style={page}>
    <h1 style={heading}>Bugs</h1>
    <ScreenState variant="error" title="Could not load this screen" body={message} />
    <p style={muted}>Nothing was read; this is the board refusing, not an empty board.</p>
  </main>);
}

export default function ScreenView({ data }: { data: ScreenData }) {
  return <ScreenSurface title="Bugs">{ScreenContent({ data })}</ScreenSurface>;
}
