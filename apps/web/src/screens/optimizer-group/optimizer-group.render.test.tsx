// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { populated } from '../optimizer-groups/render-fixture';
import { GroupPerformance } from './performance';
import { performance, unavailablePerformance } from './render-fixture';
import { verifyScreen } from '../render-test-support';
import SharedError from '../shared-error';
import Screen from './view';
import { descriptor } from './descriptor';
verifyScreen(descriptor, [
  { state: 'loading', name: 'loading group history', render: () => <p aria-busy="true">Loading group history…</p>, text: 'Loading' },
  { state: 'error', name: 'group error', render: () => <SharedError error={new Error('Synthetic error')} reset={() => {}} />, text: 'Try again' },
  { state: 'gated', name: 'group gate', render: () => <Screen data={{ view: 'gated', props: { entry: { state: 'no-database' } } }} />, text: 'database' },
  { state: 'empty', name: 'empty profile', render: () => <Screen data={{ view: 'empty', props: {} }} />, text: 'No profiles' },
  { state: 'not-measured', name: 'no group facts', render: () => <GroupPerformance performance={unavailablePerformance} currency="USD" profileId="33333333-3333-4333-8333-333333333333" />, text: 'Performance history unavailable' },
  { state: 'ready', name: 'group detail tabs', render: () => <Screen data={{ view: 'ready', props: { ...populated.props, record: populated.props.workspace.groups[0]!, performance } }} />, text: 'Settings' },
  { state: 'ready', name: 'measured group facts', render: () => <GroupPerformance performance={performance} currency="USD" profileId="33333333-3333-4333-8333-333333333333" />, text: '$12.00' },
]);
it('renders all twelve unavailable metric cells without manufacturing zeros', () => {
  const markup = renderToStaticMarkup(<GroupPerformance performance={unavailablePerformance} currency="USD" profileId="33333333-3333-4333-8333-333333333333" />);
  expect((markup.match(/<td>Unavailable<\/td>/g) ?? []).length).toBe(12);
  expect(markup).not.toContain('$0.00'); expect(markup).toContain('No reporting data for this period');
});
it('renders measured values and preserves undefined ACOS for zero sales', () => {
  const markup = renderToStaticMarkup(<GroupPerformance performance={{ ...performance, current: { ...performance.current, metrics: { spend: 0, sales: 0, orders: 0, acos: null } } }} currency="USD" profileId="33333333-3333-4333-8333-333333333333" />);
  expect(markup).toContain('$0.00'); expect(markup).toContain('Unavailable');
});
