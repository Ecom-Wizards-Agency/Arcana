// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import Loading from '../../../app/creators/conflicts/[id]/loading';
import SharedError from '../../../app/creators/conflicts/[id]/error';
import { rendered } from '../render-test-support';
import { verifyScreen } from '../settings/render-support';
import { descriptor } from './descriptor';
import { detail, lockedSinceUnknown, missing, namedOnly, notInConflict, ready, refused } from './render-fixture';
import Screen, { CONFLICT_REASON, LOCKED_ACTIONS } from './view';

verifyScreen(descriptor, [
  { state: 'loading', name: 'renders the route loading boundary', render: () => <Loading />, text: '' },
  { state: 'error', name: 'renders the shared error boundary with its reference', render: () => <SharedError error={Object.assign(new Error('Synthetic failure'), { digest: 'synthetic-reference' })} reset={() => { }} />, text: 'synthetic-reference' },
  { state: 'error', name: 'preserves the safe read error message', render: () => <Screen data={{ view: 'error', props: { message: 'Synthetic read unavailable' } }} />, text: 'Synthetic read unavailable' },
  { state: 'ready', name: 'draws two records on one storefront where nothing may act (445:298)', render: () => <Screen data={ready} />, text: CONFLICT_REASON },
  { state: 'refused', name: 'says the last read failed and still lets nothing act', render: () => <Screen data={refused} />, text: 'Nothing was read', absent: ['button:not([disabled])'] },
  { state: 'not-measured', name: 'says locked since is not recorded rather than inventing a date', render: () => <Screen data={lockedSinceUnknown} />, text: 'not recorded, the runner kept no date' },
  { state: 'empty', name: 'says a record that is not in Conflict has no conflict, and links to it', render: () => <Screen data={notInConflict} />, text: 'This record is not in Conflict', absent: ['[data-testid="conflict-record"]', 'button'] },
  { state: 'empty', name: 'says no such record is registered', render: () => <Screen data={missing} />, text: 'No creator record CCR-SW-26-0999 is registered for this organisation.' },
  { state: 'gated', name: 'keeps viewers out', render: () => <Screen data={{ view: 'gated', props: {} }} />, text: 'Owners, admins and analysts only' },
]);

describe('creator record conflict', () => {
  it('puts the two records side by side with the shared fingerprint class and no fingerprint value', () => {
    const host = rendered(<Screen data={ready} />);
    expect(host.querySelector('[data-status="run-by-hand"]')?.textContent).toBe('Run by hand');
    const cards = [...host.querySelectorAll('[data-testid="conflict-record"]')];
    expect(cards.map((card) => card.getAttribute('data-record'))).toEqual(['CCR-SW-26-0117', 'CCR-SW-26-0203']);
    expect(cards.map((card) => card.getAttribute('data-self'))).toEqual(['true', 'false']);
    expect(cards.map((card) => [...card.querySelectorAll('[data-shared]')].map((item) => item.getAttribute('data-shared')))).toEqual([['storefront'], ['storefront']]);
    expect(cards[1]!.textContent).toContain('Named by the resolution that locked it');
    expect(cards[0]!.querySelector('a')?.getAttribute('href')).toBe('/creators/records/CCR-SW-26-0117');
    expect(host.querySelectorAll('[data-lock="Conflict"]')).toHaveLength(2);
    for (const value of [...Object.values(detail.record.fingerprints), ...Object.values(detail.counterparts[0]!.record.fingerprints)]) {
      if (value !== null) expect(host.innerHTML).not.toContain(value.slice(0, 16));
    }
    expect(host.querySelector('[data-testid="locked-since"]')?.textContent).toMatch(/^Locked since 31 Aug 2026$/);
    expect(host.querySelector('[data-testid="conflict-reason"]')?.textContent).toContain('through a shared storefront fingerprint');
  });

  it('renders every action control disabled with the visible reason', () => {
    const host = rendered(<Screen data={ready} />);
    const buttons = [...host.querySelectorAll('button')];
    expect(buttons).toHaveLength(LOCKED_ACTIONS.length);
    expect(buttons.map((button) => button.textContent)).toEqual([...LOCKED_ACTIONS]);
    expect(buttons.every((button) => button.hasAttribute('disabled') && button.getAttribute('aria-describedby') === 'conflict-reason')).toBe(true);
    expect(host.querySelector('[data-testid="disabled-reason"]')?.textContent).toBe(CONFLICT_REASON);
    expect(host.querySelector('#conflict-reason')).not.toBeNull();
  });

  it('lists the identity events newest first, with time not recorded where the runner kept none', () => {
    const host = rendered(<Screen data={ready} />);
    const rows = [...host.querySelectorAll('[data-testid="identity-event"]')];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('CCR-SW-26-0203');
    expect(rows[0]!.textContent).toContain('Locked in Conflict with another record');
    expect(rows[1]!.querySelector('[data-time="not-recorded"]')?.textContent).toBe('time not recorded');
  });

  it('says when a counterpart was named by the resolution but shares no fingerprint class', () => {
    const host = rendered(<Screen data={namedOnly} />);
    expect(host.querySelectorAll('[data-testid="shared-none"]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-shared]')).toHaveLength(0);
    expect(host.querySelector('[data-testid="conflict-reason"]')?.textContent).not.toContain('through a shared');
  });

  it('links a record that is not in Conflict back to its record page', () => {
    const host = rendered(<Screen data={notInConflict} />);
    expect(host.querySelector('[data-testid="record-link"]')?.getAttribute('href')).toBe('/creators/records/CCR-SW-26-0117');
    expect(host.querySelector('[data-creator-state="not-in-conflict"]')?.textContent).toContain('CCR-SW-26-0117 is unlocked');
  });
});
