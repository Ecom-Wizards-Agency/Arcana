/**
 * The acceptance check in the brief, stated as a test: facts can be present and
 * the banner must still say stale, because the banner reads the ledger.
 */
import { describe, expect, it } from 'vitest';
import { assessFreshness } from './freshness.js';
import type { ReportLedgerEntry } from './freshness.js';
import type { FreshnessCoverage } from '@wizard-ads/shared';

const NOW = new Date('2026-08-14T09:00:00Z');

function entry(overrides: Partial<ReportLedgerEntry> = {}): ReportLedgerEntry {
  return {
    reportType: 'sp_campaigns',
    status: 'completed',
    endDate: '2026-08-13',
    requestedAt: '2026-08-14T03:00:00Z',
    completedAt: '2026-08-14T03:20:00Z',
    rowsParsed: 4200,
    rowsLoaded: 4200,
    countsMatch: true,
    error: null,
    ...overrides,
  };
}

describe('assessFreshness', () => {
  it('is green when the newest load completed inside the window', () => {
    const assessment = assessFreshness([entry()], { now: NOW });
    expect(assessment.tone).toBe('good');
    expect(assessment.headline).toContain('Fresh');
    expect(assessment.coversThrough).toBe('2026-08-13');
    expect(assessment.staleTypes).toEqual([]);
  });

  it('is stale when the last successful load is older than the threshold — no matter what the facts hold', () => {
    const stale = entry({
      requestedAt: '2026-08-11T03:00:00Z',
      completedAt: '2026-08-11T03:20:00Z',
      endDate: '2026-08-10',
    });
    const assessment = assessFreshness([stale], { now: NOW });
    expect(assessment.tone).toBe('warn');
    expect(assessment.staleTypes).toEqual(['sp_campaigns']);
    expect(assessment.headline).toContain('Stale');
  });

  it('reads staleness from the last *successful* load, not the newest attempt', () => {
    const entries = [
      entry({ requestedAt: '2026-08-11T03:00:00Z', completedAt: '2026-08-11T03:20:00Z' }),
      // A newer attempt that failed must not make the profile look fresh.
      entry({ status: 'failed', requestedAt: '2026-08-14T03:00:00Z', completedAt: null, error: 'HTTP 429' }),
    ];
    const assessment = assessFreshness(entries, { now: NOW });
    expect(assessment.tone).toBe('warn');
    expect(assessment.staleTypes).toEqual(['sp_campaigns']);
    expect(assessment.details.join(' ')).toContain('newest attempt failed');
  });

  it('is red when a report type has never completed', () => {
    const assessment = assessFreshness([entry({ status: 'pending', completedAt: null })], { now: NOW });
    expect(assessment.tone).toBe('bad');
    expect(assessment.headline).toContain('No completed load');
  });

  it('is red when the load parsed more rows than it wrote', () => {
    const lossy = entry({ rowsParsed: 4200, rowsLoaded: 4100, countsMatch: false });
    const assessment = assessFreshness([lossy], { now: NOW });
    expect(assessment.tone).toBe('bad');
    expect(assessment.lossyTypes).toEqual(['sp_campaigns']);
    expect(assessment.details.join(' ')).toContain('parsed 4,200, wrote 4,100');
  });

  it('does not let a backfill that completes an OLD window last drag coverage backwards', () => {
    // The current window loaded at 03:20; a comparison-window backfill for
    // July finished LATER. Coverage must stay at the furthest day loaded.
    const assessment = assessFreshness(
      [
        entry({ endDate: '2026-08-13', completedAt: '2026-08-14T03:20:00Z' }),
        entry({
          endDate: '2026-07-27',
          requestedAt: '2026-08-14T05:00:00Z',
          completedAt: '2026-08-14T05:30:00Z',
        }),
      ],
      { now: NOW },
    );
    expect(assessment.coversThrough).toBe('2026-08-13');
    expect(assessment.tone).toBe('good');
  });

  it('reports per report type, and takes the newest end date across all of them', () => {
    const assessment = assessFreshness(
      [
        entry({ reportType: 'sp_search_terms', endDate: '2026-08-12' }),
        entry({ reportType: 'sp_campaigns', endDate: '2026-08-13' }),
      ],
      { now: NOW },
    );
    expect(assessment.details).toHaveLength(2);
    expect(assessment.coversThrough).toBe('2026-08-13');
  });

  it('flags only the stale type when another is fresh', () => {
    const assessment = assessFreshness(
      [
        entry({ reportType: 'sp_campaigns' }),
        entry({
          reportType: 'sp_search_terms',
          requestedAt: '2026-08-09T03:00:00Z',
          completedAt: '2026-08-09T03:30:00Z',
        }),
      ],
      { now: NOW },
    );
    expect(assessment.staleTypes).toEqual(['sp_search_terms']);
  });

  it('says nothing was ever requested rather than calling an empty ledger fresh', () => {
    const assessment = assessFreshness([], { now: NOW });
    expect(assessment.tone).toBe('muted');
    expect(assessment.coversThrough).toBeNull();
    expect(assessment.headline).toContain('has ever been requested');
  });

  it('honours a custom staleness threshold', () => {
    const sixHoursOld = entry({
      requestedAt: '2026-08-14T02:00:00Z',
      completedAt: '2026-08-14T02:00:00Z',
    });
    expect(assessFreshness([sixHoursOld], { now: NOW }).tone).toBe('good');
    expect(assessFreshness([sixHoursOld], { now: NOW, staleAfterHours: 4 }).tone).toBe('warn');
  });
});

it('assesses a free-text SP-API source without changing the Ads enum', () => {
  const assessment = assessFreshness([{
    source: 'selling_partner_api', reportType: 'sales_and_traffic', status: 'complete',
    coveredThrough: '2026-08-13', observedAt: '2026-08-14T08:00:00.000Z',
    sourceRows: 3, parsedRows: 3, loadedRows: 3, refusedRows: 0, countsMatch: true,
  }], { now: NOW });
  expect(assessment.tone).toBe('good');
  expect(assessment.coversThrough).toBe('2026-08-13');
  expect(assessment.details).toHaveLength(1);
  expect(assessment.details[0]).toContain('selling_partner_api/sales_and_traffic');
  expect(assessment.details[0]).toContain('3 rows');
});

it('keeps unknown coverage counts unknown and respects aggregation assertions', () => {
  const coverage = {
    source: 'selling_partner_api', reportType: 'sales_and_traffic', status: 'complete',
    coveredThrough: '2026-08-13', observedAt: '2026-08-14T08:00:00.000Z',
    sourceRows: null, parsedRows: null, loadedRows: null, refusedRows: null, countsMatch: null,
  };
  expect(assessFreshness([coverage], { now: NOW }).details[0]).not.toContain('0 rows');
  expect(assessFreshness([{ ...coverage, sourceRows: 5, parsedRows: 5,
    loadedRows: 1, refusedRows: 0, countsMatch: true }], { now: NOW }).tone).toBe('good');
});

describe('verified coverage spans (WP-324)', () => {
  const coverage = (overrides: Partial<FreshnessCoverage> = {}): FreshnessCoverage => ({
    source: 'amazon_reporting_v3', reportType: 'spTargeting', status: 'complete',
    coveredThrough: '2026-08-13', observedAt: '2026-08-14T08:00:00.000Z',
    sourceRows: 4, parsedRows: 4, loadedRows: 4, refusedRows: 0, countsMatch: true, ...overrides,
  });

  it('measures a source through its newest held day, with the days held and the gaps', () => {
    const assessment = assessFreshness([coverage({
      verified: { from: '2026-08-01', through: '2026-08-12', daysHeld: 10, gapDays: 2 },
    })], { now: NOW });
    expect(assessment.tone).toBe('good');
    expect(assessment.coversThrough).toBe('2026-08-12');
    expect(assessment.details).toEqual([
      'amazon_reporting_v3/spTargeting: loaded 1 h ago, covers through 2026-08-12, 10 days held since 2026-08-01 (2 not loaded), 4 rows',
    ]);
  });

  it('says not measured, never fresh, when completed loads held no day', () => {
    const assessment = assessFreshness([coverage({ verified: null })], { now: NOW });
    expect(assessment.tone).toBe('muted');
    expect(assessment.coversThrough).toBeNull();
    expect(assessment.headline).toBe('Not measured: completed loads for amazon_reporting_v3/spTargeting have returned no day to hold.');
    expect(assessment.details[0]).toContain('not measured: no returned day held yet');
  });

  it('takes coverage from the measured source when another holds no day', () => {
    const assessment = assessFreshness([
      coverage({ verified: { from: '2026-08-10', through: '2026-08-13', daysHeld: 4, gapDays: 0 } }),
      coverage({ reportType: 'sbCampaigns', coveredThrough: '2026-08-14', verified: null }),
    ], { now: NOW });
    expect(assessment.tone).toBe('good');
    expect(assessment.coversThrough).toBe('2026-08-13');
    expect(assessment.details).toHaveLength(2);
  });

  it('keeps range-only freshness for sources that record no verified span', () => {
    expect(assessFreshness([coverage()], { now: NOW }).coversThrough).toBe('2026-08-13');
  });
});
