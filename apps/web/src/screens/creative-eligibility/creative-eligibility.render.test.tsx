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
  { state: 'ready', name: 'renders its complete synthetic state', render: () => <Screen data={visualFixture('eligibility')} />, text: 'Moderation states' },
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


it('counts measured and unmeasured assets and shows scope, reasons and selection refusal', () => {
  const data = visualFixture('eligibility');
  if (data.view !== 'ready') throw new Error('Expected ready synthetic fixture');
  const asset = data.props.workspace.assets[0]!;
  asset.eligibility = [{ context: { scope: { region: 'EU', amazonProfileId: '1000000001' }, marketplace: 'DE', program: 'SB_VIDEO' },
    identity: { assetId: asset.assetId!, version: 'asset-v1' }, canRun: 'ineligible', selectable: false,
    status: 'rejected', evidenceState: 'measured', reasons: ['The image contains prohibited content.'], observedAt: '2026-09-15T10:00:00Z' }];
  render(<Screen data={data} />);
  const table = screen.getByRole('region', { name: 'Asset eligibility and moderation' });
  expect(within(table).getAllByRole('row')).toHaveLength(3);
  expect(within(table).getAllByLabelText(/^Not measured:/)).toHaveLength(3);
  expect(screen.getByText(/1 of 2 assets have measured/)).toBeTruthy();
  expect(screen.getByText('Not eligible')).toBeTruthy();
  expect(screen.getByText('The image contains prohibited content.')).toBeTruthy();
  expect(screen.getByText(/SB_VIDEO · DE · asset-v1/)).toBeTruthy();
});
