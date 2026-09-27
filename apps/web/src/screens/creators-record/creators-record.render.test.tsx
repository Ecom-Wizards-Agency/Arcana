// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import Loading from '../../../app/creators/records/[id]/loading';
import SharedError from '../../../app/creators/records/[id]/error';
import { rendered } from '../render-test-support';
import { verifyScreen } from '../settings/render-support';
import { descriptor } from './descriptor';
import { creatorRecordParam } from './record-id';
import { conflicted, detail, fingerprint, malformed, missing, notMeasured, ready, refused } from './render-fixture';
import Screen from './view';

verifyScreen(descriptor, [
  { state: 'loading', name: 'renders the route loading boundary', render: () => <Loading />, text: '' },
  { state: 'error', name: 'renders the shared error boundary with its reference', render: () => <SharedError error={Object.assign(new Error('Synthetic failure'), { digest: 'synthetic-reference' })} reset={() => { }} />, text: 'synthetic-reference' },
  { state: 'error', name: 'preserves the safe read error message', render: () => <Screen data={{ view: 'error', props: { message: 'Synthetic read unavailable' } }} />, text: 'Synthetic read unavailable' },
  { state: 'ready', name: 'draws the rung, the refused candidates and everything since (445:2)', render: () => <Screen data={ready} />, text: 'Rung 1: the storefront fingerprint matched' },
  { state: 'refused', name: 'withholds the queue row when the last read failed', render: () => <Screen data={refused} />, text: 'Nothing was read', absent: ['[data-testid="queue-item"]'] },
  { state: 'not-measured', name: 'says an unscored record is not measured, never 0 / 10', render: () => <Screen data={notMeasured} />, text: 'It is not 0 / 10.', absent: ['[data-testid="ten-checks"]', '[data-testid="computed-score"]'] },
  { state: 'not-measured', name: 'says the rung is not recorded when no creator:write key registered it', render: () => <Screen data={notMeasured} />, text: 'Not recorded: the file import does not carry the rung; a creator:write key registers it.' },
  { state: 'empty', name: 'says no such record is registered', render: () => <Screen data={missing} />, text: 'No creator record CCR-SW-26-0999 is registered for this organisation.' },
  { state: 'empty', name: 'says a malformed address names no record', render: () => <Screen data={malformed} />, text: 'This address does not name a creator record id.' },
  { state: 'gated', name: 'keeps viewers out', render: () => <Screen data={{ view: 'gated', props: {} }} />, text: 'Owners, admins and analysts only' },
]);

describe('creator record', () => {
  it('draws the identity rung, the fingerprints as prefixes only, and both refused candidates with the rule in words', () => {
    const host = rendered(<Screen data={ready} />);
    expect(host.querySelector('[data-status="run-by-hand"]')?.textContent).toBe('Run by hand');
    expect(host.querySelector('h1')?.textContent).toContain('Creator record CCR-SW-26-0134');
    expect(host.querySelector('[data-testid="identity-rung"]')?.getAttribute('data-rung')).toBe('storefront');
    const prints = host.querySelector('[data-testid="record-fingerprints"]')!;
    expect([...prints.querySelectorAll('[data-fingerprint]')].map((item) => item.textContent)).toEqual([
      `storefront ${fingerprint('storefront-0134').slice(0, 8)}…`, `thread ${fingerprint('thread-0134').slice(0, 8)}…`,
      'full name recorded', 'email not recorded', 'phone not recorded', 'address recorded']);
    // No full fingerprint anywhere on the page.
    for (const value of Object.values(detail.record.fingerprints)) if (value !== null) expect(host.innerHTML).not.toContain(value);
    const refusedRows = [...host.querySelectorAll('[data-testid="refused-candidate"]')];
    expect(refusedRows).toHaveLength(2);
    expect(refusedRows.map((row) => row.getAttribute('data-rule'))).toEqual(['one_contact_fingerprint', 'thread_on_other_campaign']);
    expect(refusedRows[0]!.textContent).toContain('one contact fingerprint is shared, and the runner needs two to match');
    expect(refusedRows[1]!.textContent).toContain('the thread fingerprint is shared, but on another campaign');
    expect(refusedRows[0]!.querySelector('a')?.getAttribute('href')).toBe('/creators/records/CCR-SW-26-0091');
    expect(host.querySelectorAll('[data-testid="matching-record"]')).toHaveLength(0);
    expect(host.querySelector('[data-testid="no-matching"]')?.textContent).toBe('No other record matches it.');
    expect(host.querySelector('[data-testid="conflict-banner"]')).toBeNull();
  });

  it('shows all ten checks with the disagreement called out, and the queue row it is on today', () => {
    const host = rendered(<Screen data={ready} />);
    const checks = [...host.querySelectorAll('[data-testid="record-qualification"] [data-check]')];
    expect(checks).toHaveLength(10);
    expect(checks.filter((check) => check.getAttribute('data-passed') === 'true')).toHaveLength(8);
    expect(host.querySelector('[data-testid="computed-score"]')?.textContent).toMatch(/^8 \/ 10 computed by the runner on 9 Sept? 2026; 2 missing\.$/);
    const agreement = host.querySelector('[data-testid="score-agreement"]')!;
    expect(agreement.getAttribute('data-agreement')).toBe('disagrees');
    expect(agreement.textContent).toContain('the runner computes 8 / 10');
    const queue = host.querySelector('[data-testid="queue-item"]')!;
    expect(queue.getAttribute('data-action')).toBe('RECONCILE_QUALIFICATION');
    expect(queue.textContent).toContain('BLOCKED');
    expect(queue.textContent).toContain('status_score_drift');
  });

  it('lists everything since newest first, in words, with time not recorded where the runner kept none', () => {
    const host = rendered(<Screen data={ready} />);
    const rows = [...host.querySelectorAll('[data-testid="record-event"]')];
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => row.getAttribute('data-action'))).toEqual(['draft_approved', 'score_recorded', 'message_sent_by_hand', 'identity_resolved',
      'mcf_reservation_cancelled']);
    expect(rows[2]!.textContent).toContain('Message sent by hand in Amazon');
    expect(rows[2]!.textContent).toContain('ev:thread-0134-2');
    expect(rows[4]!.querySelector('[data-time="not-recorded"]')?.textContent).toBe('time not recorded');
    expect(rows[4]!.textContent).toContain('runner file import');
    expect(rows[4]!.textContent).toContain('MCFR-LEGACY-0A1B2C3D4E5F');
    expect(host.querySelectorAll('[data-time="not-recorded"]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-testid="record-sample"]')).toHaveLength(1);
    expect(host.querySelector('[data-testid="record-sample"]')?.getAttribute('data-lane')).toBe('Cancelled');
    const drafts = [...host.querySelectorAll('[data-testid="record-draft"]')];
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.textContent).toContain('First-base verification after background check');
    expect(host.querySelector('[data-testid="record-drafts"]')?.textContent).toContain('Approving a draft sends nothing');
  });

  it('keeps an open draft actionable here, since the drafts screen shows only the newest day', () => {
    const host = rendered(<Screen data={ready} />);
    const decision = host.querySelector('[data-testid="record-draft"] [data-testid="draft-decision"]')!;
    expect(decision.querySelector('[data-testid="draft-status"]')?.getAttribute('data-status')).toBe('approved');
    expect([...decision.querySelectorAll('button')].map((button) => [button.getAttribute('data-move'), button.hasAttribute('disabled')]))
      .toEqual([['sent_by_hand', false], ['withdrawn', false]]);
    const analyst = rendered(<Screen data={{ view: 'ready', props: { ...ready.props, canDecide: false } }} />);
    expect(analyst.querySelectorAll('[data-testid="record-draft"] button')).toHaveLength(2);
    expect(analyst.querySelectorAll('[data-testid="record-draft"] button:not([disabled])')).toHaveLength(0);
    // Under a Conflict lock the approved draft can be withdrawn but not marked sent.
    const locked = rendered(<Screen data={conflicted} />);
    expect([...locked.querySelectorAll('[data-testid="record-draft"] button')].map((button) => [button.getAttribute('data-move'), button.hasAttribute('disabled')]))
      .toEqual([['sent_by_hand', true], ['withdrawn', false]]);
    const closed = rendered(<Screen data={{ view: 'ready', props: { ...ready.props, detail: { ...detail,
      drafts: [{ ...detail.drafts[0]!, status: 'sent_by_hand', closedBy: detail.drafts[0]!.approvedBy, closedAt: '2026-09-09T08:00:00.000Z' }] } } }} />);
    expect(closed.querySelectorAll('[data-testid="record-draft"] button')).toHaveLength(0);
    expect(closed.querySelector('[data-testid="record-draft"]')?.textContent).toContain('Sent by hand');
  });

  it('never renders a missing score or tracker score as zero', () => {
    const host = rendered(<Screen data={notMeasured} />);
    // The only "0 / 10" on the page is the sentence saying the score is not that.
    expect(host.textContent?.match(/\d+ \/ 10/g)).toEqual(['0 / 10']);
    expect(host.textContent).toContain('It is not 0 / 10.');
    expect(host.querySelector('[data-testid="score-agreement"]')?.textContent).toBe('No tracker score reported.');
    expect(host.querySelector('[data-testid="record-status"]')?.textContent).toBe('Status: not reported');
    expect(host.querySelector('[data-testid="queue-none"]')?.textContent).toBe('The newest queue run did not name this record.');
    expect(host.querySelectorAll('[data-testid="record-event"]')).toHaveLength(0);
    const tracked = rendered(<Screen data={{ view: 'ready', props: { detail: { ...notMeasured.props.detail, trackerScore: { score: 7, scoredOn: '2026-09-09' } }, canDecide: true } }} />);
    expect(tracked.querySelector('[data-testid="score-agreement"]')?.getAttribute('data-agreement')).toBe('not-measured');
    expect(tracked.querySelector('[data-testid="score-agreement"]')?.textContent).toContain('the computed score is not measured');
  });

  it('links a Conflict-locked record to its conflict and names the matching record', () => {
    const host = rendered(<Screen data={conflicted} />);
    const banner = host.querySelector('[data-testid="conflict-banner"]')!;
    expect(banner.querySelector('a')?.getAttribute('href')).toBe('/creators/conflicts/CCR-SW-26-0117');
    expect(host.querySelectorAll('[data-testid="matching-record"]')).toHaveLength(1);
    expect(host.querySelector('[data-testid="matching-record"]')?.textContent).toContain('CCR-SW-26-0203');
    expect(host.querySelector('[data-testid="record-identity"]')?.textContent).toContain('A match means a Conflict lock');
  });

  it('withholds only the queue row on refusal and keeps the history', () => {
    const host = rendered(<Screen data={refused} />);
    expect(host.querySelector('[data-testid="queue-withheld"]')).not.toBeNull();
    expect(host.querySelectorAll('[data-testid="record-event"]')).toHaveLength(5);
  });

  it('accepts only a record id in the runner\'s shape from the path', () => {
    expect(creatorRecordParam('CCR-SW-26-0134')).toBe('CCR-SW-26-0134');
    for (const value of [undefined, '', 'ccr-sw-26-0134', '00000000-0000-4000-8000-000000000333', 'CCR-SW-26-01']) expect(creatorRecordParam(value)).toBeNull();
  });
});
