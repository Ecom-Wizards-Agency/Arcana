// @vitest-environment jsdom
import Loading from '../../../app/crosscheck/loading';
import { verifyScreen } from '../settings/render-support';
import SharedError from '../../../app/crosscheck/error';
import { context } from '../synthetic-render-fixtures';
import { descriptor } from './descriptor';
import { compared, ready } from './render-fixture';
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import Screen from './view';

verifyScreen(descriptor, [
  { state: 'loading', name: 'renders the route loading boundary', render: () => <Loading />, text: '' },
  { state: 'error', name: 'renders the shared error boundary with its reference', render: () => <SharedError error={Object.assign(new Error('Synthetic failure'), { digest: 'synthetic-reference' })} reset={() => { }} />, text: 'synthetic-reference' },
  { state: 'ready', name: 'renders the screen with synthetic data', render: () => <Screen data={ready} />, text: "No comparison completed yet." },
  { state: 'gated', name: 'explains an unavailable database', render: () => <Screen data={{ view: 'gated', props: { entry: { state: 'no-database' } } }} />, text: 'database' },
  { state: 'gated', name: 'explains missing organization membership', render: () => <Screen data={{ view: 'gated', props: { entry: { state: 'no-org', context: { ...context, active: null, memberships: [] } } } }} />, text: 'organisation' },
  { state: 'empty', name: 'shows the empty workspace', render: () => <Screen data={ready} />, text: "No comparison completed yet." }
]);

it('says no comparison has completed and names the next step', () => {
  render(<Screen data={ready} />);
  expect(screen.getAllByText('No comparison completed yet.')).toHaveLength(1);
  expect(screen.getAllByText('A comparison runs when an AdLabs export for a connected profile reaches the crosscheck inbox. Check back after the next scheduled export.')).toHaveLength(1);
  expect(screen.queryByText(/Nothing has been cross-checked/)).toBeNull();
  expect(screen.queryByTestId('crosscheck-summary')).toBeNull();
});

it('treats a selected profile with no stored verdicts as not compared', () => {
  const empty = { ...compared.props.data.model, days: [], campaignsCompared: 0 };
  render(<Screen data={{ view: 'ready', props: { data: { ...compared.props.data, model: empty, ranAt: null } } }} />);
  expect(screen.getAllByText('No comparison completed yet.')).toHaveLength(1);
  expect(screen.queryByTestId('crosscheck-summary')).toBeNull();
});

it('says what was compared, over which data dates, and when the comparison ran', () => {
  render(<Screen data={compared} />);
  const lines = [...screen.getByTestId('crosscheck-summary').querySelectorAll('p')].map((line) => line.textContent);
  expect(lines).toEqual([
    'Compared AdLabs exports against Arcana: 2 profile days and 4 campaign-weeks.',
    'Data compared: 12 Sept 2026 – 13 Sept 2026. 1 provisional day not compared yet. Last run: 15 Sept 2026 06:10 UTC.',
  ]);
  expect(screen.queryByText('No comparison completed yet.')).toBeNull();
});

it('does not invent a run time or a data range it does not have', () => {
  const provisionalOnly = { ...compared.props.data.model, days: [compared.props.data.model.days[0]!], campaignsCompared: 1 };
  render(<Screen data={{ view: 'ready', props: { data: { ...compared.props.data, model: provisionalOnly, ranAt: null } } }} />);
  const lines = [...screen.getByTestId('crosscheck-summary').querySelectorAll('p')].map((line) => line.textContent);
  expect(lines).toEqual([
    'Compared AdLabs exports against Arcana: 0 profile days and 1 campaign-week.',
    'Data compared: no settled day yet. 1 provisional day not compared yet. Last run: time unavailable.',
  ]);
});
