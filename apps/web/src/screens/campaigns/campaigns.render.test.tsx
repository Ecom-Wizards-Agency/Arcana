// @vitest-environment jsdom
import Loading from '../../../app/campaigns/loading';
import { verifyScreen } from '../render-test-support';
import SharedError from '../shared-error';
import { descriptor } from './descriptor';
import { ready } from './render-fixture';
import Screen from './view';
import { campaignVisualCases } from './visual-cases';

verifyScreen(descriptor, [
  { state: 'loading', name: 'renders the route loading boundary', render: () => <Loading />, text: '' },
  { state: 'error', name: 'renders the shared error boundary with its reference', render: () => <SharedError error={Object.assign(new Error('Synthetic failure'), { digest: 'synthetic-reference' })} reset={() => { }} />, text: 'synthetic-reference' },
  { state: 'ready', name: 'renders the screen with synthetic data', render: () => <Screen data={ready} />, text: "Create campaigns" },
  { state: 'error', name: 'preserves the safe read error message', render: () => <Screen data={{ view: 'error', message: 'Synthetic read unavailable' }} />, text: 'Synthetic read unavailable' },
  ...campaignVisualCases.filter((item) => item.screen === descriptor.id).map((item) => ({ ...item, name: item.key })),
]);
