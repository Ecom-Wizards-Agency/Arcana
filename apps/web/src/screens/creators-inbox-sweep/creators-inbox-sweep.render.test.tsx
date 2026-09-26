// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import Loading from '../../../app/creators/sweep/loading';
import SharedError from '../../../app/creators/sweep/error';
import { rendered } from '../render-test-support';
import { verifyScreen } from '../settings/render-support';
import { descriptor } from './descriptor';
import { latest, noSweepFile, notImported, notProduced, ready, refused } from './render-fixture';
import Screen from './view';

verifyScreen(descriptor, [
  { state: 'loading', name: 'renders the route loading boundary', render: () => <Loading />, text: '' },
  { state: 'error', name: 'renders the shared error boundary with its reference', render: () => <SharedError error={Object.assign(new Error('Synthetic failure'), { digest: 'synthetic-reference' })} reset={() => { }} />, text: 'synthetic-reference' },
  { state: 'error', name: 'preserves the safe read error message', render: () => <Screen data={{ view: 'error', props: { message: 'Synthetic read unavailable' } }} />, text: 'Synthetic read unavailable' },
  { state: 'ready', name: 'draws how the list was drained and what could not match (443:2)', render: () => <Screen data={ready} />, text: 'This sweep did not reconcile.' },
  { state: 'refused', name: 'refuses when the last read failed', render: () => <Screen data={refused} />, text: 'Nothing was read', absent: ['[data-testid="sweep-count"]'] },
  { state: 'not-measured', name: 'says no sweep was imported rather than zero', render: () => <Screen data={notImported} />, text: 'It is not zero' },
  { state: 'not-measured', name: 'shows a skipped sweep file as not measured and hides the older sweep', render: () => <Screen data={notProduced} />, text: '(1 counted invalid)', absent: ['[data-testid="sweep-count"]'] },
  { state: 'not-measured', name: 'shows an import without a sweep file as not measured', render: () => <Screen data={noSweepFile} />, text: 'read no sweep checkpoint', absent: ['[data-testid="sweep-count"]'] },
  { state: 'gated', name: 'keeps viewers out', render: () => <Screen data={{ view: 'gated', props: {} }} />, text: 'Owners, admins and analysts only' },
]);

describe('inbox sweep against CREATOR-FIXTURE.json', () => {
  it('states the completion equation with the fixture counts and refuses to call it reconciled', () => {
    const host = rendered(<Screen data={ready} />);
    expect(host.querySelector('[data-testid="sweep-equation"]')?.textContent).toContain('412 enumerated = 359 no-action + 37 changed + 9 held or escalated + 7 unmatched.');
    expect(host.querySelector('[data-testid="sweep-equation"]')?.textContent).toContain('7 threads could not match');
    expect([...host.querySelectorAll('[data-testid="sweep-count"] td:nth-child(2)')].map((cell) => cell.textContent)).toEqual(
      ['412', '412', '37', '96', '0', '359', '9', '5', '7']);
    expect(host.textContent).toContain('A subset of the 37 changed threads, not a fourth term.');
    expect(host.textContent).toMatch(/Run 9 Sept? 2026 06:12 UTC · Sonic Wave · evidence ev:sweep-0909/);
    expect(host.querySelectorAll('[data-testid="unmatched-thread"]')).toHaveLength(7);
    expect(host.querySelector('[data-testid="unmatched-summary"]')?.textContent).toContain('7 of 7 listed by thread fingerprint');
    expect(host.querySelector('[data-testid="sweep-outcomes"]')?.textContent).toContain('359 unchanged · 37 actioned · 6 held · 3 escalated · 7 unmatched');
    expect(host.querySelector('[data-testid="previous-sweep"]')?.textContent).toContain('405 mounted');
    expect(host.querySelector('[data-status="run-by-hand"]')?.textContent).toBe('Run by hand');
  });

  it('shows a balanced equation as reconciled, and a missing thread list as not measured', () => {
    const clean = { ...latest, reconciled: true, counts: { ...latest.counts, unmatched: 0, noActionAcknowledgements: 366 }, unresolved: [], outcomes: null };
    const host = rendered(<Screen data={{ view: 'ready', props: { snapshot: { ...ready.props.snapshot, latest: clean } } }} />);
    expect(host.textContent).toContain('This sweep reconciled.');
    expect(host.textContent).toContain('Every thread resolved to one record.');
    expect(host.querySelector('[data-testid="sweep-outcomes"]')?.textContent).toContain('not measured');
    const unbalanced = rendered(<Screen data={{ view: 'ready', props: { snapshot: { ...ready.props.snapshot, latest: { ...latest, counts: { ...latest.counts, mounted: 420 } } } } }} />);
    expect(unbalanced.querySelector('[data-testid="sweep-equation"]')?.textContent).toContain('420 enumerated ≠');
  });
});
