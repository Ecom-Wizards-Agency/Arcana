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
  { state: 'ready', name: 'renders the screen with synthetic data', render: () => <Screen data={ready} />, text: "Sponsored Brands video creatives · 1 Aug 2026 – 29 Aug 2026" },
  { state: 'gated', name: 'explains an unavailable database', render: () => <Screen data={{ view: 'gated', props: { entry: { state: 'no-database' } } }} />, text: 'database' },
  { state: 'gated', name: 'explains missing organization membership', render: () => <Screen data={{ view: 'gated', props: { entry: { state: 'no-org', context: { ...context, active: null, memberships: [] } } } }} />, text: 'organisation' },
  { state: 'empty', name: 'shows an empty profile roster without invented data', render: () => <Screen data={{ view: 'empty', props: {} }} />, text: "profiles" },
  { state: 'not-measured', name: 'does not substitute measured results for absent evidence', render: () => <Screen data={ready} />, text: "Creative performance is not measured until the first creative sync completes" }
]);

describe('Creatives leads with its state', () => {
  /** The element straight after the page header, and whether it precedes every evidence panel. */
  const pageHeader = () => screen.getByTestId('creative-screen').querySelector<HTMLElement>(':scope > header')!;
  function lead() {
    const header = pageHeader();
    expect(header.textContent).toContain('Creatives');
    const first = header.nextElementSibling as HTMLElement;
    const evidence = screen.getByRole('region', { name: 'Amazon provider evidence' });
    expect(first.compareDocumentPosition(evidence) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    return first;
  }
  it('not connected: no profile leads with connecting Amazon Ads', () => {
    render(<Screen data={{ view: 'empty', props: {} }} />);
    const header = screen.getByRole('heading', { name: 'Creatives' }).closest('header')!;
    const first = header.nextElementSibling as HTMLElement;
    expect(first.textContent).toContain('No profiles yet');
    expect(within(first).getByRole('link', { name: 'Connect Amazon Ads' }).getAttribute('href')).toBe('/settings/connections');
  });
  it('not measured: leads with the missing first sync and says nobody has to start it', () => {
    render(<Screen data={ready} />);
    const first = lead();
    expect(first.getAttribute('data-testid')).toBe('creative-not-measured');
    expect(within(first).getByRole('heading', { level: 2 }).textContent).toBe('Not measured yet');
    expect(first.textContent).toContain('Creative performance is not measured until the first creative sync completes. Creative sync runs by default for every synced profile, so Arcana queues it on its own; nobody needs to start it.');
    expect(within(first).getByRole('link', { name: 'Sync status →' }).getAttribute('href')).toContain('/sync-status?profile=');
    expect(screen.getByTestId('creative-screen').getAttribute('data-lead')).toBe('not_measured');
    expect(pageHeader().textContent).not.toContain('Creative Performance');
    expect(screen.getAllByTestId('creative-not-measured')).toHaveLength(1);
  });
  it('profile sync off: leads with who turns it back on and where', () => {
    const data = visualFixture('selected-asset');
    if (data.view !== 'ready') throw new Error('Expected ready fixture');
    data.props.evidence = { ...data.props.evidence, producerEligible: false, reason: 'profile_sync_disabled' };
    render(<Screen data={data} />);
    const first = lead();
    expect(first.getAttribute('data-testid')).toBe('creative-profile-sync-disabled');
    expect(first.textContent).toContain("Creative sync runs by default for every synced profile, but this profile's sync is off, so no creative observations are scheduled. An owner or admin turns it back on in Settings → Profiles; Sync status shows when the first run is queued.");
    expect(within(first).getByRole('link', { name: 'Settings → Profiles' }).getAttribute('href')).toBe('/settings/profiles');
    expect(within(first).getByRole('link', { name: 'Sync status →' }).getAttribute('href')).toContain('/sync-status?profile=');
    expect(screen.getByTestId('creative-screen').getAttribute('data-lead')).toBe('profile_sync_disabled');
  });
  it('deployment flag: leads with the flag and who can remove it', () => {
    render(renderVisualFixture('sync-off'));
    const first = lead();
    expect(first.getAttribute('data-testid')).toBe('creative-sync-disabled');
    expect(first.textContent).toContain('The deployment flag OPENSPELL_CREATIVE_SYNC_DISABLED=1 stops new creative observations for every profile. Whoever runs this deployment has to remove the flag; nothing on this page turns it back on.');
    expect(first.textContent).toContain('Evidence already collected stays visible below.');
    expect(screen.getByTestId('creative-screen').getAttribute('data-lead')).toBe('deployment_disabled');
  });
  it('deployment flag without any measured asset does not promise retained evidence', () => {
    const data = visualFixture('sync-off');
    if (data.view !== 'ready') throw new Error('Expected ready fixture');
    for (const asset of data.props.workspace.assets) asset.performance = null;
    data.props.evidence = { ...data.props.evidence, snapshot: null };
    render(<Screen data={data} />);
    const first = lead();
    expect(first.getAttribute('data-testid')).toBe('creative-sync-disabled');
    expect(first.textContent).toContain('Whoever runs this deployment has to remove the flag; nothing on this page turns it back on.');
    expect(first.textContent).not.toContain('stays visible below');
  });
  it('measured: keeps the performance lead and shows no state notice', () => {
    render(renderVisualFixture('selected-asset'));
    expect(screen.getByTestId('creative-screen').getAttribute('data-lead')).toBe('measured');
    expect(pageHeader().textContent).toContain('Creative Performance · 2 Sponsored Brands video creatives · 1 Aug 2026 – 29 Aug 2026');
    const first = pageHeader().nextElementSibling!;
    expect(first.getAttribute('aria-label')).toBe('Amazon provider evidence');
    for (const id of ['creative-not-measured', 'creative-profile-sync-disabled', 'creative-sync-disabled']) expect(screen.queryByTestId(id)).toBeNull();
  });
});

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
  it('explains the deployment kill switch above the retained creative observations', () => {
    render(renderVisualFixture('sync-off'));
    const notice = screen.getByTestId('creative-sync-disabled');
    expect(notice.textContent).toContain('Creative sync is switched off for this deployment');
    expect(notice.textContent).toContain('deployment_disabled');
    expect(within(notice).getByRole('link', { name: 'Sync status →' }).getAttribute('href')).toContain('/sync-status?profile=');
    // The switch stops new observations; the two retained rows stay visible below the notice.
    const list = screen.getByRole('complementary', { name: 'Creative list' });
    expect(within(list).getAllByTestId('creative-list-row')).toHaveLength(2);
    expect(notice.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId('creative-lifecycle').getAttribute('data-state')).toBe('performance_ready');
  });
  it('shows a new profile without facts as not measured', () => {
    render(renderVisualFixture('no-facts'));
    expect(screen.getByTestId('creative-not-measured').textContent).toContain('not measured until the first creative sync completes');
    expect(within(screen.getByTestId('creative-not-measured')).getByRole('link', { name: 'Sync status →' }).getAttribute('href')).toContain('/sync-status?profile=');
  });
  it('keeps observed assets without performance unmeasured before the first sync', () => {
    const data = visualFixture('selected-asset');
    if (data.view !== 'ready') throw new Error('Expected ready fixture');
    data.props.evidence.snapshot = null;
    for (const asset of data.props.workspace.assets) asset.performance = null;
    expect(data.props.workspace.assets).toHaveLength(2);
    render(<Screen data={data} />);
    expect(screen.getByTestId('creative-not-measured').textContent).toContain('not measured until the first creative sync completes');
  });
  it('explains disabled profile sync separately from the deployment switch and keeps retained rows', () => {
    const data = visualFixture('selected-asset');
    if (data.view !== 'ready') throw new Error('Expected ready fixture');
    data.props.evidence = { ...data.props.evidence, producerEligible: false, reason: 'profile_sync_disabled' };
    render(<Screen data={data} />);
    const notice = screen.getByTestId('creative-profile-sync-disabled');
    expect(notice.textContent).toContain('Profile sync is switched off');
    expect(screen.queryByTestId('creative-sync-disabled')).toBeNull();
    const list = screen.getByRole('complementary', { name: 'Creative list' });
    expect(within(list).getAllByTestId('creative-list-row')).toHaveLength(2);
    expect(notice.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it('explains a switched-off profile without facts in the sync evidence too', () => {
    const data = structuredClone(ready);
    data.props.evidence = { ...data.props.evidence, producerEligible: false, reason: 'profile_sync_disabled' };
    render(<Screen data={data} />);
    expect(screen.getByTestId('creative-profile-sync-disabled').textContent).toContain('Profile sync is switched off');
    expect(screen.getByTestId('creative-lifecycle').textContent).toContain('Profile sync is switched off');
    expect(screen.getByTestId('creative-not-measured').textContent).toContain('not measured until the first creative sync completes');
  });
  it('shows the deployment switch above the retained eligibility view', () => {
    const data = visualFixture('sync-off');
    if (data.view !== 'ready') throw new Error('Expected ready fixture');
    data.props.mode = 'eligibility';
    render(<Screen data={data} />);
    const notice = screen.getByTestId('creative-sync-disabled');
    expect(notice.textContent).toContain('deployment_disabled');
    const eligibility = screen.getByRole('region', { name: 'Asset eligibility' });
    // Header row plus the two retained assets.
    expect(within(screen.getByRole('region', { name: 'Asset eligibility and moderation' })).getAllByRole('row')).toHaveLength(3);
    expect(notice.compareDocumentPosition(eligibility) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it('names the deployment switch in the sync evidence before any snapshot exists', () => {
    const data = visualFixture('sync-off');
    if (data.view !== 'ready') throw new Error('Expected ready fixture');
    data.props.evidence = { ...data.props.evidence, snapshot: null };
    render(<Screen data={data} />);
    const lifecycle = screen.getByTestId('creative-lifecycle');
    expect(lifecycle.getAttribute('data-state')).toBe('inactive');
    expect(lifecycle.textContent).toContain('Creative sync is switched off for this deployment');
    expect(lifecycle.textContent).not.toContain('Profile sync is switched off');
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

it('renders listing and promotion values in Creatives history rows', () => {
  const data = visualFixture('history');
  if (data.view !== 'ready') throw new Error('Expected ready fixture');
  const base = data.props.workspace.changes[0]!;
  data.props.workspace.changes = [
    { ...base, id:'listing-price',kind:'Listing',field:'price',oldValue:10,newValue:12 },
    { ...base, id:'listing-buybox',kind:'Listing',field:'buyBoxPrice',oldValue:null,newValue:12 },
    { ...base, id:'promotion-deal',kind:'Promotion',field:'lightningDeal',oldValue:false,newValue:true },
    { ...base, id:'promotion-coupon',kind:'Promotion',field:'coupon',oldValue:null,newValue:[-10,0] },
    { ...base, id:'listing-stock',kind:'Listing',field:'inStock',oldValue:true,newValue:false },
  ];
  const host = render(<Screen data={data} />);
  const rows = Array.from(host.container.querySelectorAll('[aria-label="Creative change history"] tbody tr')).map((row)=>row.textContent);
  expect(rows).toHaveLength(5);
  for (const text of ['Price: $10.00 → $12.00','Buy Box price: not observed → $12.00','Lightning deal: No → Yes',
    'Coupon: not observed → one-time source value -10, Subscribe & Save source value 0','In stock: Yes → No']) {
    expect(rows.some((row)=>row?.includes(text))).toBe(true);
  }
});
