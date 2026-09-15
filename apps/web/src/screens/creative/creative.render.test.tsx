// @vitest-environment jsdom
import Loading from '../../../app/creative/loading';
import { verifyScreen } from '../render-test-support';
import SharedError from '../shared-error';
import { context } from '../synthetic-render-fixtures';
import { descriptor } from './descriptor';
import { ready } from './render-fixture';
import Screen from './view';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { visualFixture, renderVisualFixture } from './render-fixture';
import { CreativeThumbnail } from './presentation';

verifyScreen(descriptor, [
  { state: 'loading', name: 'renders the route loading boundary', render: () => <Loading />, text: '' },
  { state: 'error', name: 'renders the shared error boundary with its reference', render: () => <SharedError error={Object.assign(new Error('Synthetic failure'), { digest: 'synthetic-reference' })} reset={() => { }} />, text: 'synthetic-reference' },
  { state: 'ready', name: 'renders the screen with synthetic data', render: () => <Screen data={ready} />, text: "Creative Performance · 0 Sponsored Brands video creatives · 1 Aug 2026 – 29 Aug 2026" },
  { state: 'gated', name: 'explains an unavailable database', render: () => <Screen data={{ view: 'gated', props: { entry: { state: 'no-database' } } }} />, text: 'database' },
  { state: 'gated', name: 'explains missing organization membership', render: () => <Screen data={{ view: 'gated', props: { entry: { state: 'no-org', context: { ...context, active: null, memberships: [] } } } }} />, text: 'organisation' },
  { state: 'empty', name: 'shows an empty profile roster without invented data', render: () => <Screen data={{ view: 'empty', props: {} }} />, text: "profiles" },
  { state: 'not-measured', name: 'does not substitute measured results for absent evidence', render: () => <Screen data={ready} />, text: "Creative sync is not active for this profile" }
]);

describe('Creatives list and overview evidence', () => {
  it('formats the window, first observation and sync evidence in words', () => {
    render(renderVisualFixture('selected-asset'));
    const host = screen.getByTestId('creative-screen');
    expect(host.textContent).toContain('1 Aug 2026 – 29 Aug 2026');
    expect(host.textContent).toContain('first seen 22 Jul 2026');
    expect(host.textContent).toContain('Observed 29 Aug 2026, 12:00 UTC');
    expect(host.textContent).toContain('Evidence date 1 Aug 2026 – 29 Aug 2026');
    expect(host.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
  it('names the hosted pilot gate and keeps its sync link', () => {
    render(renderVisualFixture('pilot-off'));
    expect(screen.getByTestId('creative-pilot-gated').textContent).toContain('creativeSyncPilotFromEnv');
    expect(screen.queryByRole('complementary', { name: 'Creative list' })).toBeNull();
    expect(within(screen.getByTestId('creative-pilot-gated')).getByRole('link', { name: 'Sync status →' }).getAttribute('href')).toContain('/sync-status?profile=');
  });
  it('shows an enabled pilot without facts as not measured', () => {
    render(renderVisualFixture('no-facts'));
    expect(screen.getByTestId('creative-not-measured').textContent).toContain('not measured');
  });
  it('selects the requested asset, retains both list rows and keeps all shipped controls', () => {
    render(renderVisualFixture('selected-asset'));
    const list = screen.getByRole('complementary', { name: 'Creative list' });
    expect(within(list).getAllByTestId('creative-list-row')).toHaveLength(2);
    expect(within(list).getByRole('button', { name: /Synthetic cut b/ }).getAttribute('aria-pressed')).toBe('true');
    for (const label of ['Find creative', 'Campaign type', 'Attribution', 'Sort by']) expect(within(list).getByLabelText(label)).toBeTruthy();
    expect(within(list).getByText('Attribution key')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open in-depth ↗' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'View on Amazon' }).getAttribute('title')).toBe('No ASIN on this asset');
    fireEvent.change(within(list).getByLabelText('Find creative'), { target: { value: 'not-in-the-roster' } });
    expect(within(list).queryAllByTestId('creative-list-row')).toHaveLength(0);
    fireEvent.click(within(list).getByRole('button', { name: 'Clear filters' }));
    expect(within(list).getAllByTestId('creative-list-row')).toHaveLength(2);
    fireEvent.click(within(list).getByRole('button', { name: /Synthetic cut a/ }));
    expect(within(list).getByRole('button', { name: /Synthetic cut a/ }).getAttribute('aria-pressed')).toBe('true');
  });
  it('uses the first row by default and counts all four completion stages', () => {
    render(<Screen data={visualFixture('quartiles-absent')} />);
    expect(within(screen.getByRole('complementary', { name: 'Creative list' })).getByRole('button', { name: /Synthetic cut a/ }).getAttribute('aria-pressed')).toBe('true');
    const overview = screen.getByRole('region', { name: 'Creative overview' });
    for (const label of ['First quartile', 'Midpoint', 'Third quartile', 'Complete']) expect(within(overview).getByText(label)).toBeTruthy();
    expect(within(overview).getAllByLabelText(/Not measured: .*was not reported/)).toHaveLength(4);
    expect(overview.textContent).toContain('Completion quartiles are not measured');
  });
  it('renders reported funnel counts and percentages of impressions', () => {
    render(renderVisualFixture('selected-asset'));
    const overview = screen.getByRole('region', { name: 'Creative overview' });
    expect(overview.textContent).toContain('4,410');
    expect(overview.textContent).toContain('52.5%');
    expect(overview.textContent).toContain('Percentages are of impressions');
  });
  it('renders an already expired thumbnail and handles a later URL failure', () => {
    render(<><CreativeThumbnail url="https://assets.example.test/expired.jpg?Expires=1" name="Expired synthetic asset" /><CreativeThumbnail url="https://assets.example.test/late-failure.jpg" name="Failed synthetic asset" /></>);
    expect(screen.getByRole('img', { name: 'Expired synthetic asset: Thumbnail expired or unavailable' })).toBeTruthy();
    fireEvent.error(screen.getByRole('img', { name: 'Failed synthetic asset' }));
    expect(screen.getByRole('img', { name: 'Failed synthetic asset: Thumbnail expired or unavailable' })).toBeTruthy();
  });
  it('does not replace an unknown selected asset with the first row', () => {
    render(renderVisualFixture('asset-unavailable'));
    expect(screen.getByRole('heading', { name: 'Asset unavailable' })).toBeTruthy();
    expect(screen.queryByRole('article', { name: 'Selected creative' })).toBeNull();
  });
  it('keeps external ASIN navigation limited to the product URL and safe attributes', () => {
    const data = visualFixture('selected-asset');
    if (data.view !== 'ready') throw new Error('Ready fixture required');
    data.props.workspace.assets[1]!.advertisedAsin = 'B000SYN267';
    render(<Screen data={data} />);
    const link = screen.getByRole('link', { name: 'View on Amazon' });
    expect(link.getAttribute('href')).toBe('https://www.amazon.com/dp/B000SYN267');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });
});
