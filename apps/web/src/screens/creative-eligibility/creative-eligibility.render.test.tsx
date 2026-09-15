// @vitest-environment jsdom
import { verifyScreen } from '../render-test-support';
import Loading from '../shared-loading';
import SharedError from '../shared-error';
import { visualFixture } from '../creative/render-fixture';
import Screen from './view';
import { descriptor } from './descriptor';
import { render, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
verifyScreen(descriptor, [
  { state: 'loading', name: 'renders pending evidence', render: () => <Loading />, text: '' },
  { state: 'error', name: 'renders a safe read failure', render: () => <SharedError error={Object.assign(new Error('Synthetic failure'), { digest: 'synthetic-reference' })} reset={() => {}} />, text: 'synthetic-reference' },
  { state: 'gated', name: 'keeps the membership gate explicit', render: () => <Screen data={visualFixture('membership-gated')} />, text: 'database' },
  { state: 'empty', name: 'keeps the absent profile roster explicit', render: () => <Screen data={visualFixture('no-profiles')} />, text: 'No profiles yet' },
  { state: 'not-measured', name: 'renders missing source evidence', render: () => <Screen data={visualFixture('eligibility')} />, text: 'Not measured' },
  { state: 'ready', name: 'renders its complete synthetic state', render: () => <Screen data={visualFixture('eligibility')} />, text: 'The states this will carry' },
]);

it('counts every observed asset and keeps all three moderation columns unmeasured', () => {
  const data = visualFixture('eligibility');
  if (data.view !== 'ready') throw new Error('Expected ready synthetic fixture');
  data.props.workspace.assets[0]!.campaignIds.push('synthetic-mapping-only-campaign', 'synthetic-fact-only-campaign');
  render(<Screen data={data} />);
  const table = screen.getByRole('region', { name: 'Asset eligibility and moderation' });
  expect(within(table).getAllByRole('row')).toHaveLength(3);
  expect(within(table).getAllByLabelText(/^Not measured:/)).toHaveLength(6);
  expect(within(table).getAllByText('1 campaigns')).toHaveLength(2);
  for (const label of ['Awaiting review', 'Approved', 'Rejected', 'Unknown']) expect(screen.getByText(label)).toBeTruthy();
});
