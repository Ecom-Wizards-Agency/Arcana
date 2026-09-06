// @vitest-environment jsdom
/**
 * The recommendation queue, now rendered through the Data Grid.
 *
 * jsdom has no layout engine, so the virtualizer is handed one viewport-sized
 * box through the component's `initialGridRect` seam and everything downstream
 * is the production component, the same arrangement `campaign-workspace.test.ts`
 * uses.
 *
 * The behaviour worth pinning here is what a decision does to the screen. It
 * used to end in `window.location.reload()`, which threw away the filter, the
 * selection, the open evidence and the result message. It now applies an
 * optimistic status, asks the router to refresh, and leaves every one of those
 * standing.
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProposalView } from '../../src/recommendations/view';
import { ReviewWorkspace } from './review';

const VIEWPORT = { width: 1400, height: 600 };

class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = StubResizeObserver;
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
  configurable: true,
  get: () => VIEWPORT.width,
});
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
  configurable: true,
  get: () => VIEWPORT.height,
});
Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
  configurable: true,
  get: () => 10_000_000,
});
Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
  configurable: true,
  value(this: HTMLElement, options: ScrollToOptions | number) {
    this.scrollTop = typeof options === 'number' ? options : options.top ?? 0;
    setTimeout(() => this.dispatchEvent(new Event('scroll')), 0);
  },
});

const navigation = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => navigation }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: Array<{ unmount: () => void }> = [];

function proposal(id: string, status: string, reason: string): ProposalView {
  return {
    id,
    runId: 'run-1',
    reason,
    reasonLabel: reason === 'high_acos' ? 'High ACOS' : 'Low visibility',
    changeReason:
      reason === 'high_acos'
        ? 'Efficiency is outside the resolved policy.'
        : 'Visibility can be tested.',
    limitReason: null,
    entityType: 'keyword',
    entityId: `entity-${id}`,
    campaignId: 'campaign-synthetic',
    entityLabel: `Synthetic keyword ${id}`,
    scope: 'Synthetic campaign',
    field: 'bid',
    currentValue: '0.91',
    proposedValue: '0.87',
    delta: -0.04,
    status,
    decisionNote: null,
    exportBatchTag: null,
    strategy: {
      objective: 'unassigned',
      objectiveLabel: 'Unassigned',
      targetAcos: null,
      explanation: 'No strategy snapshot was stored.',
      optGroup: null,
      category: 'other',
      source: 'unassigned',
      cutOnAcosAlone: false,
    },
    strategyLabel: 'Unassigned',
    provenance: [{ key: 'clicks', label: 'Clicks', value: '42', hint: 'in the window' }],
    exportable: true,
  };
}

const QUEUE = [
  proposal('new', 'proposed', 'high_acos'),
  proposal('accepted', 'accepted', 'low_visibility'),
  proposal('done', 'exported', 'high_acos'),
];

function props(
  overrides: Partial<Parameters<typeof ReviewWorkspace>[0]> = {},
): Parameters<typeof ReviewWorkspace>[0] {
  return {
    proposals: QUEUE,
    runId: 'run-1',
    profileId: 'profile-1',
    client: 'Synthetic profile',
    currencyCode: 'USD',
    counts: { proposed: 1, accepted: 1, exported: 1 },
    role: 'owner',
    hasStrategySnapshot: false,
    initialGridRect: VIEWPORT,
    ...overrides,
  };
}

function mount(
  overrides: Partial<Parameters<typeof ReviewWorkspace>[0]> = {},
): { host: HTMLElement } {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push(root);
  act(() => root.render(createElement(ReviewWorkspace, props(overrides))));
  return { host };
}

function button(host: HTMLElement, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (found === undefined) throw new Error(`no button labelled '${label}'`);
  return found;
}

function header(host: HTMLElement, label: string): HTMLElement {
  const element = host.querySelector<HTMLElement>(`[role="columnheader"][aria-label="${label}"]`);
  if (element === null) throw new Error(`no column header labelled '${label}'`);
  return element;
}

function cellText(host: HTMLElement, id: string, headerLabel: string): string {
  const index = [...host.querySelectorAll('[role="columnheader"]')]
    .map((element) => element.getAttribute('aria-label') ?? '')
    .indexOf(headerLabel);
  if (index < 0) throw new Error(`no column header labelled '${headerLabel}'`);
  const row = host
    .querySelector(`[data-testid="proposal-${id}"]`)
    ?.closest('[data-testid="grid-row"]');
  if (row === null || row === undefined) throw new Error(`no rendered row for '${id}'`);
  return [...row.querySelectorAll('[role="cell"]')][index]?.textContent ?? '';
}

function statusOf(host: HTMLElement, id: string): string | null {
  return host.querySelector(`[data-testid="proposal-${id}"]`)?.getAttribute('data-status') ?? null;
}

function testid(host: HTMLElement, id: string): string {
  return host.querySelector(`[data-testid="${id}"]`)?.textContent ?? '';
}

function setSelectValue(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  if (setter === undefined) throw new Error('select value setter is unavailable');
  setter.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

function labelled(host: HTMLElement, label: string): HTMLElement {
  const element = host.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  if (element === null) throw new Error(`no element labelled '${label}'`);
  return element;
}

afterEach(() => {
  act(() => {
    for (const root of mounted.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  navigation.refresh.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ReviewWorkspace operator queue', () => {
  it('renders every loaded proposal as one grid row, in decision-queue order', () => {
    const { host } = mount();

    // One grid, not three bespoke tables, and no pagination anywhere.
    expect(host.querySelector('[data-testid="grid-shell"]')).not.toBeNull();
    expect(host.querySelector('table')).toBeNull();
    expect(host.querySelector('[role="grid"]')?.getAttribute('aria-label')).toBe('Results');

    // Every proposal is a row, in the order `groupByDecision` produces: needs
    // review, then ready to export, then completed.
    expect(
      [...host.querySelectorAll('[data-testid^="proposal-"]')].map(
        (element) => element.getAttribute('data-testid'),
      ),
    ).toEqual(['proposal-new', 'proposal-accepted', 'proposal-done']);
    expect(statusOf(host, 'new')).toBe('proposed');
    expect(statusOf(host, 'done')).toBe('exported');
    // The lane the old sections carried is now a column on the row.
    expect(cellText(host, 'new', 'Queue')).toBe('Needs review');
    expect(cellText(host, 'accepted', 'Queue')).toBe('Ready to export');
    expect(cellText(host, 'done', 'Queue')).toBe('Completed');
    expect(cellText(host, 'new', 'Reason')).toBe('High ACOS');
    expect(cellText(host, 'new', 'Δ')).toBe('-4.0%');

    // The two control columns hold a gesture, not a value, so neither
    // advertises an ordering the grid could not produce.
    expect(header(host, 'Select').getAttribute('aria-sort')).toBeNull();
    expect(header(host, 'Evidence').getAttribute('aria-sort')).toBeNull();
    expect(header(host, 'Reason').getAttribute('aria-sort')).toBe('none');

    // The queue and selection controls name the loaded rows, never the run.
    expect(testid(host, 'queue-count')).toBe('3 of 3 loaded rows shown');
    expect(testid(host, 'selection-count')).toBe('0 of 3 filtered loaded rows selected');
    expect(button(host, 'Select all 3 filtered loaded rows')).toBeInstanceOf(HTMLButtonElement);
    expect(testid(host, 'run-counts')).toContain('1 exported · 0 dismissed');

    // The filter and selection bars still precede the queue.
    const markup = host.innerHTML;
    expect(markup.indexOf('Recommendation queue')).toBeLessThan(
      markup.indexOf('Selection and decisions'),
    );
    expect(markup.indexOf('Selection and decisions')).toBeLessThan(
      markup.indexOf('data-testid="grid-shell"'),
    );

    // Notes and the irreversible-looking confirmation do not compete with the
    // queue until the operator intentionally opens that action.
    expect(host.textContent).not.toContain('Dismissal note');
    expect(host.textContent).not.toContain('Yes, export changes');
    expect(host.textContent).not.toContain('Strategy group for export');
  });

  it('groups into the decision lanes when the operator asks for it, and says what that costs', () => {
    const { host } = mount();
    const add = host.querySelector<HTMLSelectElement>('[aria-label="Add grouping level"]');
    if (add === null) throw new Error('no grouping select');

    act(() => setSelectValue(add, 'queue'));

    expect(host.querySelector('[role="treegrid"]')?.getAttribute('aria-label')).toBe(
      'Results grouped by queue',
    );
    const groups = [...host.querySelectorAll('[data-testid^="group-level-"]')].map(
      (element) => element.textContent ?? '',
    );
    expect(groups.some((text) => text.includes('Needs review'))).toBe(true);
    expect(groups.some((text) => text.includes('Ready to export'))).toBe(true);
    expect(groups.some((text) => text.includes('Completed'))).toBe(true);

    // Grouping summarises, so the individual proposals and their gestures are
    // gone; the surface says so rather than letting an operator hunt.
    expect(host.querySelectorAll('[data-testid^="proposal-"]')).toHaveLength(0);
    expect(testid(host, 'queue-grouped-note')).toContain('Remove the grouping levels');
  });

  it('sorts on a header click and again in the other direction', () => {
    const { host } = mount({ counts: { proposed: 3 }, proposals: [
      proposal('a', 'proposed', 'high_acos'),
      proposal('b', 'proposed', 'high_acos'),
      proposal('c', 'proposed', 'high_acos'),
    ] });

    const entity = header(host, 'Entity');
    const names = (): string[] =>
      [...host.querySelectorAll('[data-testid^="proposal-"]')].map(
        (element) => element.textContent ?? '',
      );
    expect(names()).toEqual([
      'Synthetic keyword a',
      'Synthetic keyword b',
      'Synthetic keyword c',
    ]);

    act(() => entity.click());
    expect(entity.getAttribute('aria-sort')).toBe('descending');
    expect(names()).toEqual([
      'Synthetic keyword c',
      'Synthetic keyword b',
      'Synthetic keyword a',
    ]);

    act(() => entity.click());
    expect(entity.getAttribute('aria-sort')).toBe('ascending');
    expect(names()[0]).toBe('Synthetic keyword a');
  });

  it('keeps the filter, the selection and the open evidence through a decision, and says what happened', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      statusText: 'OK',
      json: async () => ({ updated: 1, offered: 1, refused: [] }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { host } = mount();

    // Narrow to one proposal, take it, and open its evidence.
    const reason = [...host.querySelectorAll('select')].find(
      (candidate) => candidate.previousElementSibling?.textContent === 'Reason',
    );
    if (reason === undefined) throw new Error('no reason filter');
    act(() => setSelectValue(reason, 'high_acos'));
    expect(testid(host, 'queue-count')).toBe('2 of 3 loaded rows shown');

    act(() => labelled(host, 'Select Synthetic keyword new').click());
    expect(testid(host, 'selection-count')).toBe('1 of 2 filtered loaded rows selected · 0 accepted');
    act(() => host.querySelector<HTMLElement>('[data-testid="evidence-toggle-new"]')!.click());
    expect(host.querySelector('[data-testid="provenance-new"]')).not.toBeNull();

    await act(async () => {
      button(host, 'Accept 1 selected').click();
    });

    // The route was asked for exactly the selected id, and the router was
    // asked to refresh rather than the browser being told to reload.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    expect(request[0]).toBe('/api/recommendations/decide');
    expect(JSON.parse(request[1].body)).toEqual({ ids: ['new'], decision: 'accepted', note: '' });
    expect(navigation.refresh).toHaveBeenCalledTimes(1);

    // The optimistic status moved the row and the run counts with it.
    expect(statusOf(host, 'new')).toBe('accepted');
    expect(testid(host, 'run-counts')).toContain('2');
    expect(testid(host, 'decision-result')).toBe('1 of 1 proposals moved to accepted.');

    // And nothing the operator had built was thrown away.
    expect(reason.value).toBe('high_acos');
    expect(testid(host, 'queue-count')).toBe('2 of 3 loaded rows shown');
    expect(testid(host, 'selection-count')).toBe('1 of 2 filtered loaded rows selected · 1 accepted');
    expect(host.querySelector('[data-testid="provenance-new"]')).not.toBeNull();
  });

  it('retires the optimistic status once the server reports the same thing', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      statusText: 'OK',
      json: async () => ({ updated: 1, offered: 1, refused: [] }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    mounted.push(root);
    act(() => root.render(createElement(ReviewWorkspace, props())));

    act(() => labelled(host, 'Select Synthetic keyword new').click());
    await act(async () => {
      button(host, 'Accept 1 selected').click();
    });
    expect(statusOf(host, 'new')).toBe('accepted');

    // The refreshed server payload agrees. The row stays accepted and the
    // counts are the server's own, not the server's plus a stale local move.
    act(() =>
      root.render(
        createElement(
          ReviewWorkspace,
          props({
            proposals: [
              proposal('new', 'accepted', 'high_acos'),
              proposal('accepted', 'accepted', 'low_visibility'),
              proposal('done', 'exported', 'high_acos'),
            ],
            counts: { proposed: 0, accepted: 2, exported: 1 },
          }),
        ),
      ),
    );
    expect(statusOf(host, 'new')).toBe('accepted');
    expect(testid(host, 'run-counts')).toContain('0');
  });

  it('never presents the loaded rows as the whole run', () => {
    // The run holds forty proposals; three arrived.
    const { host } = mount({ counts: { proposed: 20, accepted: 15, exported: 5 } });

    const notice = testid(host, 'queue-truncated');
    expect(notice).toContain('loaded 3 of the 40 proposals in this run');
    expect(notice).toContain('loaded rows only');
    expect(testid(host, 'queue-count')).toBe('3 of 3 loaded rows shown');
    expect(testid(host, 'selection-count')).toBe('0 of 3 filtered loaded rows selected');
    expect(button(host, 'Select all 3 filtered loaded rows')).toBeInstanceOf(HTMLButtonElement);
    // The export control is the one count that may speak for the run, because
    // an export with no selection is executed server-side over the whole run.
    expect(button(host, 'Prepare export · 15')).toBeInstanceOf(HTMLButtonElement);
  });
});
