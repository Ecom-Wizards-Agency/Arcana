// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SignalsCell, RankGridCell, NotMeasuredCell, VerdictCell, DeltaCell, NotTheQueryChip } from './performance.js';

describe('performance evidence cells', () => {
  it('keeps four axes and distinguishes a measured zero from absence', () => {
    const { container } = render(<SignalsCell axes={[{ key: 'R', value: 7, reason: 'Rank not observed' }, { key: 'T', value: 0, reason: 'PPC not held' }, { key: 'I', value: null, reason: 'SQP onboarding pending' }]} />);
    expect(container.querySelectorAll('[data-axis]')).toHaveLength(4);
    expect(container.querySelector('[data-axis="T"]')?.getAttribute('data-measured')).toBe('true');
    expect(container.querySelector('[data-axis="I"]')?.getAttribute('data-measured')).toBe('false');
    expect(screen.getByTitle('SQP onboarding pending').getAttribute('aria-label')).toBe('I');
  });
  it('orders fourteen days left to right and separates unobserved days from observed unranked days', () => {
    const days = Array.from({ length: 14 }, (_, index) => ({ date: `2026-09-${String(index + 1).padStart(2, '0')}`, observed: index !== 3, rank: null }));
    const { container } = render(<RankGridCell days={[...days].reverse()} reason="1 day not scraped" />);
    const tiles = container.querySelectorAll('[data-rank-day]');
    expect(tiles).toHaveLength(14);
    expect(tiles[0]?.getAttribute('data-rank-day')).toBe('2026-09-01');
    expect(tiles[3]?.getAttribute('data-observed')).toBe('false');
    expect(tiles[3]?.getAttribute('title')).toContain('not scraped');
    expect(tiles[2]?.getAttribute('title')).toContain('Observed, did not rank');
    expect(screen.getByText('never ranked')).toBeTruthy();
  });
  it('renders reasons, diagnosis, query caveat and signed deltas without inventing zero', () => {
    render(<><NotMeasuredCell reason="Brand Analytics ingestion unavailable" /><VerdictCell verdict={{ diagnosis: 'Insufficient evidence', reason: 'no threshold configured' }} /><DeltaCell value={-2.4} suffix=" pts" /><NotTheQueryChip /></>);
    expect(screen.getByTitle('Brand Analytics ingestion unavailable').textContent).toBe('—');
    expect(screen.getByTitle('no threshold configured').textContent).toBe('Insufficient evidence');
    expect(screen.getByText('-2.4 pts')).toBeTruthy();
    // WP-316 (V19): the caveat reads as what the target does, not as jargon.
    expect(screen.getByText('Many searches').title).toContain('not evidence for one literal wording');
    expect(screen.queryByText('not the query')).toBeNull();
  });
});
