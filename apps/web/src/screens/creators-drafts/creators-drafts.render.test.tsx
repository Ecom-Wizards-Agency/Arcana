// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import Loading from '../../../app/creators/drafts/loading';
import SharedError from '../../../app/creators/drafts/error';
import { rendered } from '../render-test-support';
import { verifyScreen } from '../settings/render-support';
import { descriptor } from './descriptor';
import { movesFor } from './draft-decision';
import { analyst, empty, notMeasured, ready, refused, rows } from './render-fixture';
import Screen, { BLOCKED_REASON, SENDS_NOTHING, blockedMoves, byThread, draftTiles } from './view';

verifyScreen(descriptor, [
  { state: 'loading', name: 'renders the route loading boundary', render: () => <Loading />, text: '' },
  { state: 'error', name: 'renders the shared error boundary with its reference', render: () => <SharedError error={Object.assign(new Error('Synthetic failure'), { digest: 'synthetic-reference' })} reset={() => { }} />, text: 'synthetic-reference' },
  { state: 'error', name: 'preserves the safe read error message', render: () => <Screen data={{ view: 'error', props: { message: 'Synthetic read unavailable' } }} />, text: 'Synthetic read unavailable' },
  { state: 'ready', name: 'draws the day\'s drafts, approved one thread at a time (445:522)', render: () => <Screen data={ready} />, text: SENDS_NOTHING },
  { state: 'refused', name: 'shows the drafts but disables approval when the last read failed', render: () => <Screen data={refused} />, text: BLOCKED_REASON.refused, absent: ['button[data-move="approved"]:not([disabled])'] },
  { state: 'not-measured', name: 'says no drafts have been submitted rather than a day with zero', render: () => <Screen data={notMeasured} />, text: 'No drafts have been submitted', absent: ['[data-testid="draft"]'] },
  { state: 'empty', name: 'says the newest draft day holds no draft', render: () => <Screen data={empty} />, text: '12 drafts have been submitted in all.' },
  { state: 'gated', name: 'keeps viewers out', render: () => <Screen data={{ view: 'gated', props: {} }} />, text: 'Owners, admins and analysts only' },
]);

describe('creator replies', () => {
  it('groups twelve drafts into eleven threads with a short thread fingerprint and the record link', () => {
    const host = rendered(<Screen data={ready} />);
    expect(host.querySelector('[data-status="run-by-hand"]')?.textContent).toBe('Run by hand');
    const threads = [...host.querySelectorAll('[data-testid="draft-thread"]')];
    expect(threads).toHaveLength(11);
    expect(host.querySelectorAll('[data-testid="draft"]')).toHaveLength(12);
    expect(threads.map((thread) => thread.getAttribute('data-thread'))).toEqual(byThread(rows).map((group) => `${group.threadKey.slice(0, 8)}…`));
    for (const row of rows) expect(host.innerHTML).not.toContain(row.draft.threadKey);
    const twice = threads.find((thread) => thread.querySelectorAll('[data-testid="draft"]').length === 2)!;
    expect([...twice.querySelectorAll('[data-testid="draft"]')].map((item) => item.getAttribute('data-status'))).toEqual(['withdrawn', 'approved']);
    expect(twice.textContent).toContain('Proof request only when background check is incomplete');
    expect(twice.querySelector('h2 a')?.getAttribute('href')).toMatch(/^\/creators\/records\/CCR-SW-26-0\d{3}$/);
    const tile = (id: string) => host.querySelector(`[data-testid="${id}"] strong`)?.textContent;
    expect([tile('tile-drafts'), tile('tile-awaiting'), tile('tile-approved'), tile('tile-sent')]).toEqual(['12', '8', '3', '0']);
    expect(draftTiles(rows)).toEqual({ total: 12, awaiting: 8, approved: 3, sent: 0, withdrawn: 1 });
    expect(host.querySelector('[data-testid="draft-counts"]')?.textContent).toContain('11 threads · 1 withdrawn.');
  });

  it('shows the template, the body, and who approved it and when', () => {
    const host = rendered(<Screen data={ready} />);
    const approvedDrafts = [...host.querySelectorAll('[data-testid="draft"][data-status="approved"]')];
    expect(approvedDrafts).toHaveLength(3);
    expect(approvedDrafts.map((item) => item.querySelector('[data-testid="draft-meta"]')?.textContent?.match(/by (you|user \w+)$/)?.[1]).sort())
      .toEqual(['user 10000000', 'you', 'you']);
    expect(approvedDrafts[0]!.querySelector('[data-testid="draft-meta"]')?.textContent).toMatch(/approved 9 Sept? 2026 07:05 UTC/);
    const first = host.querySelector('[data-testid="draft"][data-status="draft"]')!;
    expect(first.textContent).toContain('First-base verification after background check');
    expect(first.querySelector('[data-testid="draft-body"]')?.textContent).toMatch(/^Hi \{first name\}, synthetic verification follow-up \d+\.\nSecond line/);
  });

  it('gives owners and admins one draft at a time: approve a draft, mark an approved one sent by hand, withdraw either', () => {
    const host = rendered(<Screen data={ready} />);
    const enabled = (move: string) => host.querySelectorAll(`button[data-move="${move}"]:not([disabled])`).length;
    const all = (move: string) => host.querySelectorAll(`button[data-move="${move}"]`).length;
    expect([all('approved'), all('sent_by_hand'), all('withdrawn')]).toEqual([8, 3, 11]);
    // 0203 is Conflict-locked: its approval is disabled with the reason; it can still be withdrawn.
    expect([enabled('approved'), enabled('sent_by_hand'), enabled('withdrawn')]).toEqual([7, 3, 11]);
    const locked = [...host.querySelectorAll('[data-testid="draft-thread"]')].filter((thread) => thread.querySelector('[data-lock="Conflict"]'));
    expect(locked).toHaveLength(1);
    expect(locked[0]!.textContent).toContain('CCR-SW-26-0203');
    expect(locked[0]!.querySelector('[data-testid="draft-disabled-reason"]')?.textContent).toBe(BLOCKED_REASON.conflict);
    expect(locked[0]!.querySelector('a[href="/creators/conflicts/CCR-SW-26-0203"]')).not.toBeNull();
    expect(host.querySelectorAll('[data-testid="draft-disabled-reason"]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-testid="draft"][data-status="withdrawn"] button')).toHaveLength(0);
    expect(movesFor('sent_by_hand')).toEqual([]);
    expect(movesFor('withdrawn')).toEqual([]);
  });

  it('shows analysts every draft with every control disabled and the reason', () => {
    const host = rendered(<Screen data={analyst} />);
    expect(host.querySelectorAll('[data-testid="draft"]')).toHaveLength(12);
    const buttons = [...host.querySelectorAll('button')];
    expect(buttons).toHaveLength(22);
    expect(buttons.every((button) => button.hasAttribute('disabled'))).toBe(true);
    expect(host.querySelector('[data-testid="analyst-note"]')?.textContent).toBe(BLOCKED_REASON.role);
    expect(host.querySelectorAll('[data-testid="draft-disabled-reason"]')).toHaveLength(11);
  });

  it('disables only approval after a failed read, since the queue the drafts answer did not read', () => {
    const host = rendered(<Screen data={refused} />);
    expect(host.textContent).toContain('Nothing was read');
    expect(host.querySelectorAll('[data-testid="draft"]')).toHaveLength(12);
    expect(host.querySelectorAll('button[data-move="approved"]:not([disabled])')).toHaveLength(0);
    expect(host.querySelectorAll('button[data-move="sent_by_hand"]:not([disabled])')).toHaveLength(3);
    const row = rows.find((item) => item.lockState === 'Unlocked' && item.draft.status === 'draft')!;
    expect(blockedMoves(row, { canDecide: true, refused: true })).toEqual({ approved: BLOCKED_REASON.refused, sent_by_hand: null, withdrawn: null });
    expect(blockedMoves(row, { canDecide: true, refused: false })).toEqual({ approved: null, sent_by_hand: null, withdrawn: null });
  });
});
