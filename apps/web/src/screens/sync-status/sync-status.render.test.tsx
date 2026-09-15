import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { catalogueReady } from './render-fixture';
// @vitest-environment jsdom
import Loading from '../../../app/sync-status/loading';
import { verifyScreen } from '../settings/render-support';
import SharedError from '../../../app/sync-status/error';
import { context } from '../synthetic-render-fixtures';
import { descriptor } from './descriptor';
import { ready } from './render-fixture';
import Screen from './view';

verifyScreen(descriptor, [
  { state: 'not-measured', name: 'distinguishes absent facts from a fresh zero', render: () => <Screen data={{ ...ready, props: { ...ready.props, status: { ...ready.props.status, freshness: [{ profileId: 'synthetic-profile', profileLabel: 'Synthetic profile', region: 'NA', syncEnabled: true, latestFactDate: null, queued: 0, running: 0, failed: 0 }] } } }} />, text: 'Facts not measured' },
  { state: 'loading', name: 'renders the route loading boundary', render: () => <Loading />, text: '' },
  { state: 'error', name: 'renders the shared error boundary with its reference', render: () => <SharedError error={Object.assign(new Error('Synthetic failure'), { digest: 'synthetic-reference' })} reset={() => { }} />, text: 'synthetic-reference' },
  { state: 'ready', name: 'renders the screen with synthetic data', render: () => <Screen data={ready} />, text: "Sync status" },
  { state: 'gated', name: 'explains an unavailable database', render: () => <Screen data={{ view: 'gated', props: { result: { state: 'no-database' } } }} />, text: 'database' },
  { state: 'gated', name: 'explains missing organization membership', render: () => <Screen data={{ view: 'gated', props: { result: { state: 'no-org', context: { ...context, active: null, memberships: [] } } } }} />, text: 'organisation' },
  { state: 'empty', name: 'shows the empty workspace', render: () => <Screen data={ready} />, text: "Sync status" }
]);

it('renders four source scopes with nullable, empty, complete and failed cursor counts',()=>{
  render(<Screen data={catalogueReady}/>);
  const rows=screen.getAllByTestId('catalogue-source-row');expect(rows).toHaveLength(4);
  expect(rows[0]!.textContent).toContain('UnavailableUnavailableNot run');expect(rows[0]!.textContent).not.toContain('00');
  expect(rows[1]!.children[6]!.textContent).toBe('0');expect(rows[1]!.children[7]!.textContent).toBe('0');
  expect(rows[2]!.children[7]!.textContent).toBe('3');expect(rows[3]!.textContent).toContain('Synthetic cursor failure');
});
