// @vitest-environment jsdom
import Loading from '../../../app/optimizer/review/[batchId]/loading';
import { expect, it } from 'vitest';
import { rendered, verifyScreen } from '../render-test-support';
import SharedError from '../shared-error';
import { descriptor } from './descriptor';
import { ready } from './render-fixture';
import Screen from './view';

verifyScreen(descriptor, [
  { state: 'loading', name: 'renders review loading', render: () => <Loading />, text: '' },
  { state: 'error', name: 'renders shared error evidence', render: () => <SharedError error={Object.assign(new Error('Synthetic failure'), { digest: 'synthetic-review' })} reset={() => {}} />, text: 'synthetic-review' },
  { state: 'gated', name: 'explains unavailable database', render: () => <Screen data={{ view: 'gated', props: { entry: { state: 'no-database' } } }} />, text: 'database' },
  { state: 'empty', name: 'explains absent profiles', render: () => <Screen data={{ view: 'empty', props: {} }} />, text: 'No profiles yet' },
  { state: 'not-measured', name: 'keeps absent immutable evidence unavailable', render: () => <Screen data={{ ...ready, props: { ...ready.props, details: true } }} />, text: 'Unavailable' },
  { state: 'ready', name: 'renders two saved suggestions with zero selected', render: () => <Screen data={ready} />, text: 'Select changes to continue' },
]);

it.each(['queued', 'running', 'failed'])('does not claim an empty %s preview completed', (status) => {
  const host = rendered(<Screen data={{ ...ready, props: { ...ready.props, review: { ...ready.props.review, status, proposals: [] } } }} />);
  expect(host.textContent).toContain(`Saved preview: ${status}`);
  expect(host.textContent).not.toContain('Preview completed.');
  expect(host.textContent).not.toContain('No changes were recommended.');
});
it('reports an empty completed preview only after saved success', () => {
  const host = rendered(<Screen data={{ ...ready, props: { ...ready.props, review: { ...ready.props.review, status: 'succeeded', proposals: [] } } }} />);
  expect(host.textContent).toContain('Preview completed. No changes were recommended.');
});
