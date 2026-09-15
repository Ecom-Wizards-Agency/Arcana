// @vitest-environment jsdom
import Loading from '../../../app/dayparting/loading';
import { verifyScreen } from '../render-test-support';
import SharedError from '../shared-error';
import { context } from '../synthetic-render-fixtures';
import { descriptor } from './descriptor';
import { ready, daypartingFixture } from './render-fixture';
import Screen from './view';

verifyScreen(descriptor, [
  ...(['draft', 'reviewed', 'enabled', 'paused'] as const).map(state => ({
    state, name: `registers the persisted ${state} state`,
    render: () => <Screen data={{ view: 'ready', props: daypartingFixture(state) }} />,
    text: state[0]!.toUpperCase() + state.slice(1),
  })),
  { state: 'loading', name: 'renders the route loading boundary', render: () => <Loading />, text: '' },
  { state: 'error', name: 'renders the shared error boundary with its reference', render: () => <SharedError error={Object.assign(new Error('Synthetic failure'), { digest: 'synthetic-reference' })} reset={() => { }} />, text: 'synthetic-reference' },
  { state: 'ready', name: 'renders the screen with synthetic data', render: () => <Screen data={ready} />, text: "Dayparting" },
  { state: 'gated', name: 'explains an unavailable database', render: () => <Screen data={{ view: 'gated', props: { entry: { state: 'no-database' } } }} />, text: 'database' },
  { state: 'gated', name: 'explains missing organization membership', render: () => <Screen data={{ view: 'gated', props: { entry: { state: 'no-org', context: { ...context, active: null, memberships: [] } } } }} />, text: 'organisation' },
  { state: 'empty', name: 'shows an empty profile roster without invented data', render: () => <Screen data={{ view: 'empty', props: {} }} />, text: "profiles" },
  { state: 'not-measured', name: 'does not substitute measured results for absent evidence', render: () => <Screen data={ready} />, text: "No hourly evidence in this window" }
]);
