// @vitest-environment jsdom
import Loading from '../../../app/feedback/loading';
import { verifyScreen } from '../settings/render-support';
import SharedError from '../../../app/feedback/error';
import { descriptor } from './descriptor';
import Screen from './view';

verifyScreen(descriptor, [
  { state: 'loading', name: 'renders the route loading boundary', render: () => <Loading />, text: '' },
  { state: 'error', name: 'renders the shared error boundary with its reference', render: () => <SharedError error={Object.assign(new Error('Synthetic failure'), { digest: 'synthetic-reference' })} reset={() => { }} />, text: 'synthetic-reference' },
  { state: 'ready', name: 'renders the legacy fragment bridge', render: () => <Screen data={{ view: 'bridge', props: {} }} />, text: '' }
]);
