import { describe, expect, it } from 'vitest';
import { coverageFor, type CoverageRow } from './data-evidence';
const row: CoverageRow = { report_type: 'rank_observations', earliest_returned_date: '2026-09-01', latest_loaded_date: '2026-09-14', availability_start_date: null, missing_dates: ['2026-09-03', '2026-09-05'], status: 'partial' };
describe('feed provenance', () => {
  it('counts unique held days and separately identifies days not scraped', () => {
    expect(coverageFor('RANK', [row, row], '2026-09-01', '2026-09-14')).toMatchObject({ daysHeld: 12, daysRequested: 14, notScraped: 2, status: 'partial', reason: '12 days, 2 not scraped. Other missing days predate tracking or are not held.' });
  });
  it('does not infer SQP or PPC coverage from rank coverage', () => {
    expect(coverageFor('SQP', [row], '2026-09-01', '2026-09-14')).toMatchObject({ daysHeld: 0, status: 'not-measured' });
    expect(coverageFor('PPC', [row], '2026-09-01', '2026-09-14').reason).toContain('not measured');
  });
  it('refuses unreconciled coverage', () => {
    expect(coverageFor('RANK', [{ ...row, counts_match: false }], '2026-09-01', '2026-09-14').daysHeld).toBe(0);
  });
  it('clips availability to the selected date range', () => {
    expect(coverageFor('RANK', [{ ...row, missing_dates: [], availability_start_date: '2026-09-10' }], '2026-09-01', '2026-09-14').daysHeld).toBe(5);
  });
});
describe('advertising coverage from verified spans (WP-324)', () => {
  const ppc: CoverageRow = { report_type: 'spTargeting', earliest_returned_date: '2026-09-01', latest_loaded_date: '2026-09-07', availability_start_date: null, missing_dates: ['2026-09-04', '2026-09-05'], status: 'complete', counts_match: true };
  it('holds only the days loads returned, never the gap between two requests', () => {
    expect(coverageFor('PPC', [ppc], '2026-09-01', '2026-09-07')).toEqual({ feed: 'PPC', daysHeld: 5, daysRequested: 7, notScraped: 2, status: 'partial', reason: '2026-09-01 – 2026-09-07 · 5 of 7 days held' });
    expect(coverageFor('PPC', [ppc], '2026-09-06', '2026-09-07')).toMatchObject({ status: 'complete', daysHeld: 2, reason: '2026-09-06 – 2026-09-07 · 2 of 2 days held' });
  });
  it('is not measured only when no verified day falls in the range', () => {
    expect(coverageFor('PPC', [ppc], '2026-09-04', '2026-09-05')).toMatchObject({ status: 'not-measured', daysHeld: 0, reason: 'Advertising performance not measured in this range.' });
    expect(coverageFor('PPC', [{ ...ppc, earliest_returned_date: null, missing_dates: [] }], '2026-09-01', '2026-09-07')).toMatchObject({ status: 'not-measured', daysHeld: 0 });
  });
});
