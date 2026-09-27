// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import Loading from '../../../app/creators/loading';
import SharedError from '../../../app/creators/error';
import { rendered } from '../render-test-support';
import { verifyScreen } from '../settings/render-support';
import { descriptor } from './descriptor';
import { idle, items, noQueueFile, notImported, ready, refused, snapshot, workedToZero } from './render-fixture';
import { CreatorRunnerQueueItem } from '@wizard-ads/shared';
import { orderIdleGroups, queueTiles, recordsWithoutAction } from './queue-summary';
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
  { state: 'not-measured', name: 'calls records whose status was never reported not measured, not a stage (444:2)', render: () => <Screen data={ready} />, text: 'Status not reported: 3 records.' },
  { state: 'refused', name: 'gives the label nobody recognises its own refusal group (444:2)', render: () => <Screen data={ready} />, text: 'Not in the tracker\'s dropdown.' },
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
      sweep_runs: { read: 1, valid: 0, invalid: 1, inserted: 0, updated: 0, unchanged: 0, skipped: 0, removed: 0 } } };
    const stale = rendered(<Screen data={{ view: 'ready', props: { snapshot: { ...ready.props.snapshot, lastImport: skipped } } }} />);
    expect(stale.querySelector('[data-testid="sweep-strip"]')?.textContent).toContain('could not read as a checkpoint');
    expect(stale.querySelectorAll('[data-sweep-count]')).toHaveLength(0);
  });
});

describe('creator queue in-place states', () => {
  it('opens a row in place with all ten checks and the score that disagrees (444:301)', () => {
    const host = rendered(<Screen data={ready} />);
    // Every row with a record opens; the three unresolved threads do not.
    expect(host.querySelectorAll('[data-testid="queue-row-open"]')).toHaveLength(31);
    const opened = host.querySelector('[data-testid="queue-row-open"][data-record="CCR-SW-26-0134"]')!;
    expect(opened.tagName).toBe('DETAILS');
    const checks = [...opened.querySelectorAll('[data-check]')];
    expect(checks).toHaveLength(10);
    expect(checks.map((check) => check.getAttribute('data-check'))).toEqual([
      'complete_fulfillment_details', 'requested_asin', 'exact_product_match', 'storefront_visible', 'recent_post_verified',
      'content_quality', 'category_fit', 'performance_or_revenue', 'specific_asin_mentioned', 'low_spam_risk']);
    expect(checks.filter((check) => check.getAttribute('data-passed') === 'false').map((check) => check.getAttribute('data-check')))
      .toEqual(['recent_post_verified', 'performance_or_revenue']);
    const agreement = opened.querySelector('[data-testid="score-agreement"]')!;
    expect(agreement.getAttribute('data-agreement')).toBe('disagrees');
    expect(agreement.textContent).toMatch(/The tracker says 10 \/ 10 \(scored 9 Sept? 2026\); the runner computes 8 \/ 10/);
    expect(opened.querySelector('[data-testid="open-record"]')?.getAttribute('href')).toBe('/creators/records/CCR-SW-26-0134');
    expect(opened.querySelector('[data-testid="open-drafts"]')).toBeNull();
    const agrees = host.querySelector('[data-testid="queue-row-open"][data-record="CCR-SW-26-0088"] [data-testid="score-agreement"]')!;
    expect(agrees.getAttribute('data-agreement')).toBe('agrees');
    const agreements = [...host.querySelectorAll('[data-testid="score-agreement"]')].map((element) => element.getAttribute('data-agreement'));
    expect(agreements.filter((value) => value === 'no-tracker-score')).toHaveLength(29);
    const message = host.querySelector('[data-testid="queue-row-open"][data-record="CCR-SW-26-0203"]')!;
    expect(message.querySelector('[data-testid="open-drafts"]')?.getAttribute('href')).toBe('/creators/drafts');
    expect(message.querySelector('[data-testid="open-conflict"]')?.getAttribute('href')).toBe('/creators/conflicts/CCR-SW-26-0203');
    expect(host.querySelectorAll('[data-testid="open-drafts"]')).toHaveLength(14);
  });

  it('groups the records that produced no action by status, with the unrecognised label refused and the unreported not measured (444:2)', () => {
    expect(idle.reduce((sum, group) => sum + group.records, 0)).toBe(recordsWithoutAction(items, snapshot.registryRecords));
    const ordered = orderIdleGroups(idle);
    expect(ordered.recognised).toHaveLength(10);
    expect(ordered.unrecognised.map((group) => group.status)).toEqual(['Awaiting Sample']);
    expect(ordered.unreported).toEqual({ records: 3 });
    const host = rendered(<Screen data={ready} />);
    const groups = [...host.querySelectorAll('[data-testid="idle-group"]')];
    expect(groups).toHaveLength(10);
    expect(groups.map((group) => group.getAttribute('data-status'))).toEqual(['Sample Sent', 'Delivered / Awaiting Content', 'Content Posted',
      'Performance Update', 'Manager Review', 'On Hold', 'Unqualified', 'Ghosted', 'Declined / Closed', 'Derma stamp Pause']);
    expect(groups.find((group) => group.getAttribute('data-status') === 'Unqualified')?.textContent).toBe('Unqualified61');
    const refusedGroups = [...host.querySelectorAll('[data-testid="idle-refused"]')];
    expect(refusedGroups.map((group) => group.textContent)).toEqual(['Awaiting Sample: 3 records']);
    expect(host.querySelector('[data-testid="idle-unrecognised"]')?.textContent).toContain('Not in the tracker\'s dropdown.');
    expect(host.querySelector('[data-testid="idle-unreported"]')?.textContent).toMatch(/^Status not reported: 3 records\. .*not measured\.$/);
    // Still the single count the round-1 test pins, above the groups.
    expect(host.querySelector('[data-testid="no-action"]')?.textContent).toMatch(/^241 records/);
    const zero = rendered(<Screen data={workedToZero} />);
    expect(zero.querySelectorAll('[data-testid="idle-group"]')).toHaveLength(10);
    const none = rendered(<Screen data={notImported} />);
    expect(none.querySelector('[data-testid="idle-groups"]')).toBeNull();
    const unscored = rendered(<Screen data={{ view: 'ready', props: { snapshot: { ...snapshot, idle: [{ status: null, recognised: null, records: 241 }] } } }} />);
    expect(unscored.querySelectorAll('[data-testid="idle-group"]')).toHaveLength(0);
    expect(unscored.querySelector('[data-testid="idle-unreported"]')?.textContent).toContain('241 records');
    expect(unscored.querySelector('[data-testid="idle-unreported"]')?.textContent).not.toMatch(/\b0 records/);
  });
});
