// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { verifyScreen } from '../render-test-support';
import SharedLoading from '../shared-loading';
import SharedError from '../shared-error';
import { chooserReady } from '../optimizer/choose-fixture';
import { descriptor } from './descriptor';
import Screen, { RunSettings } from './view';
verifyScreen(descriptor, [
  { state: 'loading', name: 'renders settings loading', render: () => <SharedLoading />, text: '' },
  { state: 'error', name: 'renders recoverable settings error', render: () => <SharedError error={new Error('Synthetic error')} reset={() => {}} />, text: 'Try again' },
  { state: 'gated', name: 'explains missing database', render: () => <Screen data={{ view: 'gated', props: { entry: { state: 'no-database' } } }} />, text: 'database' },
  { state: 'empty', name: 'keeps missing profiles explicit', render: () => <Screen data={{ view: 'empty', props: {} }} />, text: 'No profiles' },
  { state: 'not-measured', name: 'requires campaign scope for settings', render: () => <Screen data={chooserReady} />, text: 'Select campaigns' },
  { state: 'ready', name: 'renders effective campaign settings', render: () => <RunSettings data={chooserReady} initialDraft={{ campaignIds: chooserReady.props.campaignRows.map((row) => row.campaignId) }} />, text: 'Synthetic review group · group' },
]);
it('refuses missing assigned-group ACOS even with a populated temporary run field', () => {
  const row = chooserReady.props.campaignRows[0]!;
  render(<RunSettings data={{ ...chooserReady, props: { ...chooserReady.props, campaignRows: [{ ...row, oneTimeSettings: { ...row.oneTimeSettings, targetAcos: 0 } }] } }} initialDraft={{ campaignIds: [row.campaignId], configuration: { version: 1, method: 'sp.reference-efficiency', targetAcos: 0.37, bidFloor: 0.11, bidCeiling: 4.3, bidIncreaseCap: 0.23, bidDecreaseCap: 0.41, window: { start: '2026-07-01', end: '2026-07-28' } } }} />);
  expect(screen.getByRole('heading', { name: 'Finish campaign setup' })).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Save settings and continue' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText('If the campaign belongs to a group, update the missing setting in that group.')).toBeTruthy();
});
