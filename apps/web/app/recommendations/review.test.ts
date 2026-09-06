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

function proposal(
  id: string,
  status: string,
  reason: string,
  overrides: Partial<ProposalView> = {},
): ProposalView {
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
    ...overrides,
  };
}

/**
 * What a row's checkbox and evidence toggle are called.
 *
 * Entity alone is not a name: one run proposes a bid and a budget for the same
 * campaign, and two controls may not share an accessible name.
 */
function rowLabel(id: string, field = 'bid'): string {
  return `Synthetic keyword ${id}, ${field}, in Synthetic campaign`;
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

/** The decide route answering that it moved the single row it was offered. */
function okDecision(): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({
    ok: true,
    statusText: 'OK',
    json: async () => ({ updated: 1, offered: 1, refused: [] }),
  }));
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

function cleanupMounted(): void {
  act(() => {
    for (const root of mounted.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
}

afterEach(() => {
  cleanupMounted();
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

    act(() => labelled(host, `Select ${rowLabel('new')}`).click());
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

    act(() => labelled(host, `Select ${rowLabel('new')}`).click());
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

  it('retires the optimistic status when the refreshed payload disagrees with it', async () => {
    // The reconciliation exists for exactly this: a concurrent run superseded
    // the proposal while this operator was accepting it. Retiring only when
    // the server agrees would pin the client's claim against the database
    // forever, and the run tiles with it, until the page was reloaded.
    vi.stubGlobal('fetch', okDecision());
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    mounted.push(root);
    act(() => root.render(createElement(ReviewWorkspace, props())));

    act(() => labelled(host, `Select ${rowLabel('new')}`).click());
    await act(async () => {
      button(host, 'Accept 1 selected').click();
    });
    expect(statusOf(host, 'new')).toBe('accepted');
    expect(testid(host, 'run-counts')).toContain('2');

    act(() =>
      root.render(
        createElement(
          ReviewWorkspace,
          props({
            proposals: [
              proposal('new', 'superseded', 'high_acos'),
              proposal('accepted', 'accepted', 'low_visibility'),
              proposal('done', 'exported', 'high_acos'),
            ],
            counts: { proposed: 0, accepted: 1, exported: 1, superseded: 1 },
          }),
        ),
      ),
    );

    // The server has answered. Its answer wins, on the row and in the tiles.
    expect(statusOf(host, 'new')).toBe('superseded');
    expect(testid(host, 'run-counts')).toContain('1 exported · 0 dismissed');
    expect(testid(host, 'run-counts')).toContain('0');
  });

  it('does not flicker a second decision back when a slow earlier refresh lands', async () => {
    // An operator works down the queue faster than the server answers. The
    // payload for the first decision predates the second one and cannot speak
    // for it; retiring on the next payload to *land* would drop the second
    // claim and show the row at the status the operator had just changed.
    vi.stubGlobal('fetch', okDecision());
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    mounted.push(root);
    act(() => root.render(createElement(ReviewWorkspace, props())));

    act(() => labelled(host, `Select ${rowLabel('new')}`).click());
    await act(async () => {
      button(host, 'Accept 1 selected').click();
    });
    // Decision two, while refresh #1 is still in flight.
    act(() => labelled(host, `Select ${rowLabel('new')}`).click());
    act(() => labelled(host, `Select ${rowLabel('done')}`).click());
    await act(async () => {
      button(host, 'Accept 1 selected').click();
    });
    expect(statusOf(host, 'new')).toBe('accepted');
    expect(statusOf(host, 'done')).toBe('accepted');

    // Refresh #1 finally lands: it knows about the first decision only.
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
    expect(statusOf(host, 'done')).toBe('accepted');
    expect(testid(host, 'decision-result')).toBe('1 of 1 proposals moved to accepted.');
  });

  it('keeps the operator in place when a decision drops the row out of their filter', async () => {
    // The queue's most ordinary workflow: filter to `proposed` and work down.
    // Every decision removes rows from the filtered set, and a grid that reads
    // "the row set shrank" as "the operator re-filtered" throws them back to
    // row zero on every single decision.
    vi.stubGlobal('fetch', okDecision());
    const many = Array.from({ length: 400 }, (_, index) =>
      proposal(`p${String(index).padStart(3, '0')}`, 'proposed', 'high_acos'),
    );
    const { host } = mount({ proposals: many, counts: { proposed: 400 } });

    const status = [...host.querySelectorAll('select')].find(
      (candidate) => candidate.previousElementSibling?.textContent === 'Status',
    );
    if (status === undefined) throw new Error('no status filter');
    act(() => setSelectValue(status, 'proposed'));

    const scroller = (): HTMLElement => {
      const element = host.querySelector<HTMLElement>('[data-testid="grid-scroller"]');
      if (element === null) throw new Error('no grid scroller');
      return element;
    };
    act(() => {
      scroller().scrollTop = 4000;
      scroller().dispatchEvent(new Event('scroll'));
    });
    expect(scroller().scrollTop).toBe(4000);

    const first =
      host
        .querySelector('[data-testid^="proposal-"]')
        ?.getAttribute('data-testid')
        ?.replace('proposal-', '') ?? '';
    expect(first).not.toBe('');
    act(() => labelled(host, `Select ${rowLabel(first)}`).click());
    await act(async () => {
      button(host, 'Accept 1 selected').click();
    });

    // The decision landed, the row left the filtered set, and the operator is
    // still where they were.
    expect(testid(host, 'queue-count')).toBe('399 of 400 loaded rows shown');
    expect(scroller().scrollTop).toBe(4000);

    // Moving a filter is the operator re-asking the question, and that still
    // returns them to the top.
    act(() => setSelectValue(status, 'accepted'));
    expect(scroller().scrollTop).toBe(0);
  });

  it('refuses the grid keyboard a selection a group summary could never have', () => {
    const { host } = mount();
    const add = host.querySelector<HTMLSelectElement>('[aria-label="Add grouping level"]');
    if (add === null) throw new Error('no grouping select');
    act(() => setSelectValue(add, 'queue'));

    const row = host.querySelector<HTMLElement>('[data-testid="grid-row"]');
    if (row === null) throw new Error('no grid row');
    act(() => {
      row.focus();
      row.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    });

    // A group row is a summary of proposals, not a proposal. Nothing the
    // operator can act on was selected, so nothing claims to be.
    expect(testid(host, 'selection-count')).toBe('0 of 3 filtered loaded rows selected');
    expect(host.querySelector('[data-testid="grid-shell"]')?.textContent).not.toContain('selected');
    expect(button(host, 'Clear selection').disabled).toBe(true);
  });

  it('qualifies the grid footer count when the queue is a slice of the run', () => {
    const { host } = mount({ counts: { proposed: 20, accepted: 15, exported: 5 } });
    const shell = host.querySelector('[data-testid="grid-shell"]');
    if (shell === null) throw new Error('no grid shell');

    // The footer sits directly under the rows, closer to the eye than the
    // notice above the page, so it says the same thing the notice does.
    expect(shell.lastElementChild?.textContent).toBe('3 of 3 loaded rows · 40 in this run');

    // An untruncated queue has no population to qualify and says nothing extra.
    const { host: whole } = mount({ counts: { proposed: 1, accepted: 1, exported: 1 } });
    expect(
      whole.querySelector('[data-testid="grid-shell"]')?.lastElementChild?.textContent,
    ).toBe('3 of 3 loaded rows');
  });

  it('names each row control for the proposal it acts on, not just the entity', () => {
    // One campaign, two proposals: a bid and a budget. Naming both controls
    // after the entity gives two checkboxes one name.
    const { host } = mount({
      counts: { proposed: 2 },
      proposals: [
        proposal('bid', 'proposed', 'high_acos', { entityLabel: 'Synthetic keyword one', field: 'bid' }),
        proposal('budget', 'proposed', 'high_acos', {
          entityLabel: 'Synthetic keyword one',
          field: 'budget',
        }),
      ],
    });

    const names = [...host.querySelectorAll('input[type="checkbox"]')]
      .map((element) => element.getAttribute('aria-label') ?? '')
      .filter((name) => name.startsWith('Select Synthetic'));
    expect(names).toEqual([
      'Select Synthetic keyword one, bid, in Synthetic campaign',
      'Select Synthetic keyword one, budget, in Synthetic campaign',
    ]);
    expect(new Set(names).size).toBe(names.length);

    // The disclosure points at the panel it opens, and says it opened: the
    // panel is not in the row, it is in the stack below the queue.
    const toggle = host.querySelector<HTMLElement>('[data-testid="evidence-toggle-bid"]');
    if (toggle === null) throw new Error('no evidence toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBeNull();

    act(() => toggle.click());
    const open = host.querySelector<HTMLElement>('[data-testid="evidence-toggle-bid"]');
    expect(open?.getAttribute('aria-expanded')).toBe('true');
    expect(open?.getAttribute('aria-controls')).toBe('evidence-panel-bid');
    expect(host.querySelector('[data-testid="provenance-bid"]')?.id).toBe('evidence-panel-bid');
    expect(testid(host, 'evidence-announcement')).toBe(
      'Evidence for Synthetic keyword one opened below the queue.',
    );
  });

  it('claims a move only for the rows the route reports moving, and names every refusal', async () => {
    // The route returns a refusal only for ids that still resolve to a row, so
    // an id that resolves to nothing is neither updated nor refused. Claiming
    // it moved would contradict the count printed beside it.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        statusText: 'OK',
        json: async () => ({
          updated: 0,
          offered: 2,
          refused: [{ id: 'done', status: 'superseded' }],
        }),
      })),
    );
    const { host } = mount();

    act(() => labelled(host, `Select ${rowLabel('new')}`).click());
    act(() => labelled(host, `Select ${rowLabel('done')}`).click());
    await act(async () => {
      button(host, 'Accept 2 selected').click();
    });

    // `superseded` is a refused state too, and the message says so.
    expect(testid(host, 'decision-result')).toBe(
      '0 of 2 proposals moved to accepted. 1 refused: a proposal that has already been exported,'
        + ' applied or superseded cannot be decided again.',
    );
    // The refusal is exact — the route read it out of the database — so it is
    // written. The unaccounted-for row keeps the status the server last gave it.
    expect(statusOf(host, 'done')).toBe('superseded');
    expect(statusOf(host, 'new')).toBe('proposed');
  });

  it('stops pinning the identity column when the viewport cannot afford it', () => {
    // At 390 px the checkbox and a 260 px pinned Entity claim 304 pixels and
    // leave the other ten columns 86 to share, so the row is unreachable by
    // horizontal scroll. The pin is what has to give, not the columns.
    const width = window.innerWidth;
    try {
      const { host } = mount();
      expect(header(host, 'Entity').style.position).toBe('sticky');

      cleanupMounted();
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
      const { host: phone } = mount();
      expect(header(phone, 'Entity').style.position).toBe('relative');
      // The 44 px checkbox column is affordable at any width and stays put.
      expect(header(phone, 'Select').style.position).toBe('sticky');
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    }
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
