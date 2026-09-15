// @vitest-environment jsdom
import Loading from '../../../app/bugs/loading';
import { verifyScreen } from '../settings/render-support';
import SharedError from '../../../app/bugs/error';
import { descriptor } from './descriptor';
import { ready } from './render-fixture';
import Screen from './view';

verifyScreen(descriptor, [
  { state: 'loading', name: 'renders the route loading boundary', render: () => <Loading />, text: '' },
  { state: 'error', name: 'renders the shared error boundary with its reference', render: () => <SharedError error={Object.assign(new Error('Synthetic failure'), { digest: 'synthetic-reference' })} reset={() => { }} />, text: 'synthetic-reference' },
  { state: 'ready', name: 'renders the screen with synthetic data', render: () => <Screen data={ready} />, text: "Bugs" },
  { state: 'error', name: 'preserves the safe read error message', render: () => <Screen data={{ view: 'error', props: { message: 'Synthetic read unavailable' } }} />, text: 'Synthetic read unavailable' },
  { state: 'empty', name: 'shows the empty workspace', render: () => <Screen data={ready} />, text: "Bugs" }
]);
