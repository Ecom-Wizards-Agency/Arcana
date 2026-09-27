// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import Loading from '../../../app/creators/loading';
import SharedError from '../../../app/creators/error';
import { rendered } from '../render-test-support';
import { verifyScreen } from '../settings/render-support';
import { descriptor } from './descriptor';
import { items, noQueueFile, notImported, ready, refused, workedToZero } from './render-fixture';
import { CreatorRunnerQueueItem } from '@wizard-ads/shared';
import { queueTiles, recordsWithoutAction } from './queue-summary';
import Screen from './view';

verifyScreen(descriptor, [
  { state: 'loading', name: 'renders the route loading boundary', render: () => <Loading />, text: '' },
  { state: 'error', name: 'renders the shared error boundary with its reference', render: () => <SharedError error={Object.assign(new Error('Synthetic failure'), { digest: 'synthetic-reference' })} reset={() => { }} />, text: 'synthetic-reference' },
  { state: 'error', name: 'preserves the safe read error message', render: () => <Screen data={{ view: 'error', props: { message: 'Synthetic read unavailable' } }} />, text: 'Synthetic read unavailable' },
  { state: 'ready', name: 'draws the day\'s work over a sweep that did not reconcile (442:2)', render: () => <Screen data={ready} />, text: 'The last sweep did not reconcile' },
  { state: 'refused', name: 'refuses when the last read failed and shows no queue (443:244)', render: () => <Screen data={refused} />, text: 'Nothing was read', absent: ['[data-testid="queue-row"]', '[data-testid="tile-total"]'] },
  { state: 'empty', name: 'shows a day worked to zero over the records that did not move (443:406)', render: () => <Screen data={workedToZero} />, text: '272 records on the registry did not move' },
  { state: 'not-measured', name: 'never calls an import without a queue file worked to zero', render: () => <Screen data={noQueueFile} />, text: 'read no queue output, so the day\'s work is not measured', absent: ['[data-creator-state="worked-to-zero"]'] },
  { state: 'not-measured', name: 'says nothing was imported rather than showing zero', render: () => <Screen data={notImported} />, text: 'It is not zero' },
  { state: 'gated', name: 'keeps viewers out', render: () => <Screen data={{ view: 'gated', props: {} }} />, text: 'Owners, admins and analysts only' },
]);

describe('creator queue against CREATOR-FIXTURE.json, with the runner winning where they disagree', () => {
  it('derives the tiles and queue states from 34 rows the runner can emit', () => {
    expect(items).toHaveLength(34);
    for (const item of items) {
      const runner = CreatorRunnerQueueItem.safeParse({ queue_id: item.queueId, run_date: item.runDate, creator_record_id: item.creatorRecordId ?? 'UNRESOLVED',
        brand: item.brand, campaign_tab: item.campaignTab, current_status: item.currentStatus, computed_score: item.computedScore, missing: item.missing,
        due_date: item.dueDate, action_type: item.actionType, gate_result: item.gateResult, queue_state: item.queueState, reason: item.reason });
      expect(runner.success, item.queueId).toBe(true);
    }
    expect(items.filter((item) => item.actionType === 'RECONCILE_PRODUCT_SWITCH').every((item) => item.gateResult === 'BLOCKED' && item.queueState === 'Escalated')).toBe(true);
    expect(queueTiles(items)).toEqual({ total: 34, awaitingApproval: 14, heldOrBlocked: 20, locked: 2, queued: 24, escalated: 10 });
    expect(recordsWithoutAction(items, 272)).toBe(241);
    const byAction = Object.fromEntries([...new Set(items.map((item) => item.actionType))].map((action) => [action, items.filter((item) => item.actionType === action).length]));
    expect(byAction).toEqual({ IDENTITY_RESOLUTION: 3, BACKGROUND_CHECK: 6, SEND_TAILORED_VERIFICATION_FOLLOW_UP: 11, RECONCILE_QUALIFICATION: 2,
      MCF_PREFLIGHT: 4, RECONCILE_PRODUCT_SWITCH: 5, SEND_PRODUCT_SWITCH_FOLLOW_UP: 1, SEND_CONTENT_FOLLOW_UP: 2 });
  });

  it('renders the tiles, eight groups, every row, the sweep strip and the chip', () => {
    const host = rendered(<Screen data={ready} />);
    const tile = (id: string) => host.querySelector(`[data-testid="${id}"] strong`)?.textContent;
    expect([tile('tile-total'), tile('tile-approval'), tile('tile-held'), tile('tile-locked')]).toEqual(['34', '14', '20', '2']);
    expect(host.querySelectorAll('[data-testid="queue-group"]')).toHaveLength(8);
    expect([...host.querySelectorAll('[data-testid="queue-group"]')].map((group) => group.getAttribute('data-action'))).toEqual([
      'IDENTITY_RESOLUTION', 'BACKGROUND_CHECK', 'SEND_TAILORED_VERIFICATION_FOLLOW_UP', 'RECONCILE_QUALIFICATION', 'MCF_PREFLIGHT',
      'RECONCILE_PRODUCT_SWITCH', 'SEND_CONTENT_FOLLOW_UP', 'SEND_PRODUCT_SWITCH_FOLLOW_UP']);
    expect(host.querySelectorAll('[data-testid="queue-row"]')).toHaveLength(34);
    expect(host.querySelectorAll('[data-testid="queue-row"] em')).toHaveLength(3);
    expect(host.querySelector('[data-testid="queue-states"]')?.textContent).toContain('24 queued · 10 escalated');
    expect(host.querySelectorAll('[data-lock="Conflict"]')).toHaveLength(2);
    expect(host.querySelectorAll('[data-lock="Locked for MCF"]')).toHaveLength(1);
    const strip = host.querySelector('[data-testid="sweep-strip"]')!;
    expect([...strip.querySelectorAll('[data-sweep-count]')].map((cell) => cell.textContent)).toEqual([
      '412 mounted', '412 opened', '37 changed', '96 messages examined', '0 sent', '359 no-action', '9 held or escalated', '5 archived spam', '7 unmatched']);
    expect(strip.textContent).toMatch(/run 9 Sept? 2026 06:12 UTC · from the run checkpoint ev:sweep-0909/);
    expect(host.textContent).toMatch(/Last read 9 Sept? 2026 06:14 UTC/);
    expect(host.textContent).toContain('Sonic Wave');
    expect(host.querySelector('[data-testid="no-action"]')?.textContent).toMatch(/^241 records on the registry produced no action on 9 Sept? 2026\.$/);
    const row = [...host.querySelectorAll('[data-testid="queue-row"]')].find((element) => element.textContent?.includes('CCR-SW-26-0134'))!;
    expect(row.textContent).toContain('8 / 10');
    expect(row.textContent).toContain('recent post verified +1');
    const chip = host.querySelector('[data-status="run-by-hand"]');
    expect(chip?.textContent).toBe('Run by hand');
  });

  it('withholds the stale queue on refusal and never renders a missing sweep as zero', () => {
    const host = rendered(<Screen data={refused} />);
    expect(host.textContent).toContain('a runner file did not have the shape the runner writes (queue output)');
    expect(host.textContent).toMatch(/The queue for 9 Sept? 2026 is not shown/);
    expect(host.querySelector('.wa-page-sub')?.textContent).toMatch(/^Daily Action Queue · Last read 9 Sept? 2026 06:14 UTC \(failed\)$/);
    const noSweep = rendered(<Screen data={{ view: 'ready', props: { snapshot: { ...ready.props.snapshot, sweep: null } } }} />);
    expect(noSweep.querySelector('[data-testid="sweep-strip"]')?.textContent).toContain('not measured');
    expect(noSweep.querySelectorAll('[data-sweep-count]')).toHaveLength(0);
    // An import that skipped the sweep must not let the older sweep pass for the current one.
    const skipped = { ...ready.props.snapshot.lastImport!, counts: { ...ready.props.snapshot.lastImport!.counts,
      sweep_runs: { read: 1, valid: 0, invalid: 1, inserted: 0, updated: 0, unchanged: 0, removed: 0 } } };
    const stale = rendered(<Screen data={{ view: 'ready', props: { snapshot: { ...ready.props.snapshot, lastImport: skipped } } }} />);
    expect(stale.querySelector('[data-testid="sweep-strip"]')?.textContent).toContain('could not read as a checkpoint');
    expect(stale.querySelectorAll('[data-sweep-count]')).toHaveLength(0);
  });
});
