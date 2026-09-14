// @vitest-environment jsdom
import Loading from '../../../app/settings/connections/loading';
import { verifyScreen } from '../render-test-support';
import SharedError from '../shared-error';
import { descriptor } from './descriptor';
import { ready } from './render-fixture';
import Screen from './view';

verifyScreen(descriptor, [
  { state: 'loading', name: 'renders the route loading boundary', render: () => <Loading />, text: '' },
  { state: 'error', name: 'renders the shared error boundary with its reference', render: () => <SharedError error={Object.assign(new Error('Synthetic failure'), { digest: 'synthetic-reference' })} reset={() => { }} />, text: 'synthetic-reference' },
  { state: 'ready', name: 'renders the screen with synthetic data', render: () => <Screen data={ready} />, text: "Connections" },
  { state: 'gated', name: 'explains missing membership', render: () => <Screen data={{ view: 'no-org', props: {} }} />, text: 'organisation' },
  { state: 'empty', name: 'shows the empty workspace', render: () => <Screen data={ready} />, text: "Connections" }
]);
