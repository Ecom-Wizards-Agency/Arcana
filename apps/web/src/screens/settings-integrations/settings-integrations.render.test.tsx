// @vitest-environment jsdom
import Loading from '../../../app/settings/integrations/loading';
import { verifyScreen } from '../settings/render-support';
import SharedError from '../../../app/settings/integrations/error';
import { descriptor } from './descriptor';
import { ready } from './render-fixture';
import Screen from './view';

verifyScreen(descriptor, [
  { state: 'empty', name: 'renders the empty collection', render: () => <Screen data={ready} />, text: "Not connected yet." },
  { state: 'loading', name: 'renders the route loading boundary', render: () => <Loading />, text: '' },
  { state: 'error', name: 'renders the shared error boundary with its reference', render: () => <SharedError error={Object.assign(new Error('Synthetic failure'), { digest: 'synthetic-reference' })} reset={() => { }} />, text: 'synthetic-reference' },
  { state: 'ready', name: 'renders the screen with synthetic data', render: () => <Screen data={ready} />, text: "Integrations" },
  { state: 'gated', name: 'explains missing membership', render: () => <Screen data={{ view: 'no-org', props: {} }} />, text: 'organisation' }
]);
