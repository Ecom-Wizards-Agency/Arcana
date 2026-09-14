// @vitest-environment jsdom
import Loading from '../../../app/grid/loading';
import { verifyScreen } from '../render-test-support';
import SharedError from '../shared-error';
import { context } from '../synthetic-render-fixtures';
import { descriptor } from './descriptor';
import { ready } from './render-fixture';
import Screen from './view';

verifyScreen(descriptor, [
  { state: 'loading', name: 'renders the route loading boundary', render: () => <Loading />, text: '' },
  { state: 'error', name: 'renders the shared error boundary with its reference', render: () => <SharedError error={Object.assign(new Error('Synthetic failure'), { digest: 'synthetic-reference' })} reset={() => { }} />, text: 'synthetic-reference' },
  { state: 'ready', name: 'renders the screen with synthetic data', render: () => <Screen data={ready} />, text: "Campaigns" },
  { state: 'gated', name: 'explains an unavailable database', render: () => <Screen data={{ view: 'gated', props: { entry: { state: 'no-database' } } }} />, text: 'database' },
  { state: 'gated', name: 'explains missing organization membership', render: () => <Screen data={{ view: 'gated', props: { entry: { state: 'no-org', context: { ...context, active: null, memberships: [] } } } }} />, text: 'organisation' },
  { state: 'empty', name: 'explains an empty profile roster', render: () => <Screen data={{ view: 'empty', props: { data: { profiles: [], profile: null } } }} />, text: 'No advertising profiles yet.' },
  { state: 'not-measured', name: 'does not substitute measured results for absent evidence', render: () => <Screen data={{ ...ready, props: { ...ready.props, slot1: <></>, freshness: <></> } }} />, text: "Campaigns", absent: ['[aria-label="Performance cockpit"]'] }
]);
