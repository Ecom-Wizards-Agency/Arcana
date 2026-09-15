// @vitest-environment jsdom
import Loading from '../../../app/settings/loading';
import { verifyScreen } from '../settings/render-support';
import SharedError from '../../../app/settings/error';
import { descriptor } from './descriptor';

verifyScreen(descriptor, [
  { state: 'loading', name: 'renders the route loading boundary', render: () => <Loading />, text: '' },
  { state: 'error', name: 'renders the shared error boundary with its reference', render: () => <SharedError error={Object.assign(new Error('Synthetic failure'), { digest: 'synthetic-reference' })} reset={() => { }} />, text: 'synthetic-reference' }
]);
