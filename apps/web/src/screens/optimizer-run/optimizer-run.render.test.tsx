// @vitest-environment jsdom
import Loading from '../../../app/optimizer/run/[batchId]/loading';
import { verifyScreen } from '../render-test-support';
import SharedError from '../shared-error';
import { descriptor } from './descriptor';
import { ready, operationFixture } from './render-fixture';
import Screen from './view';

verifyScreen(descriptor, [
  { state: 'loading', name: 'renders results loading', render: () => <Loading />, text: '' },
  { state: 'error', name: 'renders shared error evidence', render: () => <SharedError error={Object.assign(new Error('Synthetic failure'), { digest: 'synthetic-results' })} reset={() => {}} />, text: 'synthetic-results' },
  { state: 'gated', name: 'explains unavailable database', render: () => <Screen data={{ view: 'gated', props: { entry: { state: 'no-database' } } }} />, text: 'database' },
  { state: 'empty', name: 'explains absent profiles', render: () => <Screen data={{ view: 'empty', props: {} }} />, text: 'No profiles yet' },
  { state: 'not-measured', name: 'keeps outcome questions unanswered before sync', render: () => <Screen data={ready} />, text: 'Not yet answerable' },
  { state: 'stale', name: 'requires fresh unresolved values', render: () => <Screen data={{ ...ready, props: { ...ready.props, retry: true, operation: operationFixture('partial') } }} />, text: 'Fresh preview required' },
  { state: 'refused', name: 'refuses unsupported forward narrowing', render: () => <Screen data={{ ...ready, props: { ...ready.props, retry: true, operation: operationFixture('partial') } }} />, text: 'This installation does not yet support that source.' },
  { state: 'ready', name: 'renders partial results from saved operation evidence', render: () => <Screen data={{ ...ready, props: { ...ready.props, operation: operationFixture('partial') } }} />, text: '1 change applied. 1 needs attention.' },
]);
