// @vitest-environment jsdom
import Loading from '../../../app/strategy/loading';
import { verifyScreen } from '../render-test-support';
import SharedError from '../shared-error';
import { descriptor } from './descriptor';

verifyScreen(descriptor, [
  { state: 'loading', name: 'renders the route loading boundary', render: () => <Loading />, text: '' },
  { state: 'error', name: 'renders the shared error boundary with its reference', render: () => <SharedError error={Object.assign(new Error('Synthetic failure'), { digest: 'synthetic-reference' })} reset={() => { }} />, text: 'synthetic-reference' }
]);
