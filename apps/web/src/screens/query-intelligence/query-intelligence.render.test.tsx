// @vitest-environment jsdom
import Loading from '../../../app/query-intelligence/loading';
import { verifyScreen } from '../render-test-support';
import SharedError from '../shared-error';
import { profile } from '../synthetic-render-fixtures';
import { descriptor } from './descriptor';
import { ready } from './render-fixture';
import Screen from './view';

verifyScreen(descriptor, [
  { state: 'loading', name: 'renders the route loading boundary', render: () => <Loading />, text: '' },
  { state: 'error', name: 'renders the shared error boundary with its reference', render: () => <SharedError error={Object.assign(new Error('Synthetic failure'), { digest: 'synthetic-reference' })} reset={() => { }} />, text: 'synthetic-reference' },
  { state: 'ready', name: 'renders the screen with synthetic data', render: () => <Screen data={ready} />, text: "Query Intelligence" },
  { state: 'error', name: 'preserves the safe read error message', render: () => <Screen data={{ view: 'error', props: { message: 'Synthetic read unavailable' } }} />, text: 'Synthetic read unavailable' },
  { state: 'empty', name: 'shows an empty profile roster without invented data', render: () => <Screen data={{ view: 'empty', props: {} }} />, text: "profiles" },
  { state: 'not-measured', name: 'does not substitute measured results for absent evidence', render: () => <Screen data={{ view: 'not-measured', props: { profile } }} />, text: "No authoritative weekly SQP data" }
]);
