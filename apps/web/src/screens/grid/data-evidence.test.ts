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
