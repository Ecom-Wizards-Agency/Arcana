// @vitest-environment jsdom
import { act } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { verifyScreen } from '../render-test-support';
import SharedError from '../shared-error';
import Loading from '../../../app/timeline/loading';
import { descriptor } from './descriptor';
import Screen from './view';
import { ready, catalogueReady } from './render-fixture';
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
verifyScreen(descriptor, [
    { state: 'ready', name: 'renders stale 49-day facts and six measures', render: () => <Screen data={ready}/>, text: '49 days of facts' },
    { state: 'empty', name: 'renders empty profile selection', render: () => <Screen data={{ view: 'empty' }}/>, text: 'No profiles yet' },
    { state: 'empty', name: 'renders an empty date range', render: () => <Screen data={{ ...ready, snapshot: { ...ready.snapshot, profile: [] } }}/>, text: 'No facts in this range' },
    { state: 'not-measured', name: 'names missing threshold reasons', render: () => <Screen data={ready}/>, text: 'Missing setting: minimum observed days' },
    { state: 'gated', name: 'explains missing admission', render: () => <Screen data={{ view: 'gated' }}/>, text: 'organisation membership' },
    { state: 'loading', name: 'renders pending evidence', render: () => <Loading />, text: '' },
    { state: 'error', name: 'renders safe failure', render: () => <SharedError error={Object.assign(new Error('Synthetic'), { digest: 'timeline-error' })} reset={() => { }}/>, text: 'timeline-error' },
]);
it('counts four measures, event kinds, markers and seven-day zoom margins', () => {
    render(<Screen data={ready}/>);
    expect(screen.getByText(/49 days of facts.*report sync failing since 6 Sep/)).toBeTruthy();
    expect(screen.getAllByTestId('timeline-measure')).toHaveLength(6);
    expect(screen.getAllByTestId('timeline-event')).toHaveLength(7);
    fireEvent.click(screen.getAllByTestId('timeline-measure')[2]!);
    fireEvent.click(screen.getAllByTestId('timeline-measure')[3]!);
    expect(screen.getByText('4 of 4 selected')).toBeTruthy();
    expect(screen.getAllByTestId(/end-label-/)).toHaveLength(4);
    fireEvent.click(screen.getByRole('button', { name: 'promotion' }));
    expect(screen.getAllByTestId('timeline-event')).toHaveLength(6);
    expect(screen.getAllByTestId('event-lane')).toHaveLength(6);
    fireEvent.click(screen.getByRole('button', { name: 'Synthetic rank experiment' }));
    expect(screen.getAllByTestId('outside-event-window')).toHaveLength(2);
    expect(screen.getByText('Spend was already falling before this experiment started')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Back to/ }));
    expect(screen.getAllByTestId('timeline-measure')).toHaveLength(6);
});
it('switches rank scopes and keeps gaps blank with applied batches and promotions by default', () => {
    render(<Screen data={ready}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Organic rank' }));
    expect(screen.getAllByTestId('timeline-event')).toHaveLength(2);
    expect(screen.queryByRole('heading',{name:'Timeline'})).toBeNull();
    expect(screen.queryByRole('link',{name:'Create experiment'})).toBeNull();
    expect(screen.queryByRole('button',{name:'Record event'})).toBeNull();
    expect(screen.getByRole('navigation',{name:'Timeline views'}).closest('.tl-rank-heading')).not.toBeNull();
    expect(document.querySelectorAll('[data-observed-point]')).toHaveLength(2);
    expect(document.querySelectorAll('[data-series-mark="line"] path')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'BSR' }));
    expect(screen.getByText('Synthetic category')).toBeTruthy();
    expect(screen.getByText(/Last observation 6 Sep/)).toBeTruthy();
});
it('renders untracked rank selection without a rank zero', () => {
    render(<Screen data={{ ...ready, snapshot: { ...ready.snapshot, ranks: [] } }}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Organic rank' }));
    expect(screen.getByText(/Missing rank is not rank zero/)).toBeTruthy();
});

it('shows independent calibration coverage and baseline contamination in READ details', () => {
    const experiment = { ...ready.snapshot.events[0]!, focus: 'spend' as const, start: '2026-08-01', end: '2026-08-07' };
    const profile = ready.snapshot.profile.filter((row) => row.date >= '2026-07-04' && row.date <= '2026-08-07');
    const snapshot = { ...ready.snapshot, profile, events: [experiment], scoped: { [experiment.id]: profile }, settings: { minDays: 2, minClicks: 1 } };
    const view = render(<Screen data={{ ...ready, snapshot }}/>);
    expect(screen.getByText('Insufficient evidence')).toBeTruthy();
    expect(screen.getByText(/Account calibration: 2 of 3 fortnights/)).toBeTruthy();
    const coupon = { ...experiment, id: 'baseline-promotion', name: 'Synthetic baseline promotion', kind: 'promotion' as const,
        start: '2026-07-25', end: '2026-07-31' };
    view.rerender(<Screen data={{ ...ready, snapshot: { ...snapshot, profile: ready.snapshot.profile,
        events: [experiment, coupon], scoped: { [experiment.id]: ready.snapshot.profile } } }}/>);
    expect(screen.getByText('Confounded by Synthetic baseline promotion (baseline)')).toBeTruthy();
    expect(screen.getByText(/Baseline contaminated by Synthetic baseline promotion/)).toBeTruthy();
});

it('hydrates the server-rendered timeline without console errors when compact currency defaults differ', async () => {
    const NativeNumberFormat = Intl.NumberFormat;
    let server = true;
    // CI's Node ICU used a $0.0 default; Chromium used $0. Explicit options
    // must win over both, including the zero tick in the real Timeline chart.
    const formatter = vi.spyOn(Intl, 'NumberFormat').mockImplementation(function(locales, options) {
        return new NativeNumberFormat(locales, options?.notation === 'compact'
            ? { minimumFractionDigits: server ? 1 : 0, ...options } : options);
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const recoverable: unknown[] = [];
    const container = document.createElement('div');
    document.body.append(container);
    let root: ReturnType<typeof hydrateRoot> | undefined;
    try {
        container.innerHTML = renderToString(<Screen data={ready}/>);
        const serverAxis = container.querySelector('[aria-label="left axis"]')!.textContent;
        expect(serverAxis).toContain('$0');
        server = false;
        await act(async () => { root = hydrateRoot(container, <Screen data={ready}/>, {onRecoverableError: error => recoverable.push(error)}); });
        expect(recoverable).toEqual([]);
        expect(serverAxis).not.toContain('$0.0');
        expect(errors.mock.calls).toEqual([]);
        expect(container.querySelector('[aria-label="left axis"]')!.textContent).toBe(serverAxis);
        expect(container.querySelectorAll('[data-testid="timeline-event"]')).toHaveLength(7);
    } finally {
        if (root) await act(async () => root!.unmount());
        container.remove();formatter.mockRestore();errors.mockRestore();
    }
});

it('renders three imported Amazon events alongside one local applied event',()=>{
  const host=render(<Screen data={catalogueReady}/>);
  const rows=screen.getAllByTestId('timeline-event');expect(rows).toHaveLength(4);
  expect(rows.filter(row=>row.textContent?.includes('Amazon observed'))).toHaveLength(3);
  expect(rows[3]!.textContent).toContain('identity conflict');expect(host.container.textContent).toContain('SYNTHETIC-MARKET-0');
  expect(screen.queryByRole('button',{name:/Restore|Acknowledge|Approve/})).toBeNull();
});
