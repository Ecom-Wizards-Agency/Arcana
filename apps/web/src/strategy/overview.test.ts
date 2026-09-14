import { upsertReportCoverage } from '@wizard-ads/db';
import { createTestDatabase } from '@wizard-ads/db/testing';
import { describe, expect, it, vi } from 'vitest';
import type { DbHandle } from '@wizard-ads/db';
import { readStrategyEvidence } from './overview.js';

describe('readStrategyEvidence', () => {
  it('maps all evidence lanes and preserves zero-valued empty states', async () => {
    const results: unknown[] = [
      [{
        report_type: 'sqp_weekly', source: 'sp_api', status: 'complete',
        earliest_returned_date: '2026-07-05', latest_loaded_date: '2026-08-22',
        latest_settled_date: '2026-08-15', missing_dates: ['2026-07-19'],
      }],
      [{
        id: 'batch', tag: 'batch-tag', opt_group: 'Profit', lever: 'bids', status: 'staged',
        applied_on: null, cooldown_until: null, exported_at: '2026-08-29T01:00:00.000Z', rows: '3',
      }],
      [{ total: '4', synchronized: '3', settling: '1', complete: '2', supported_lift: '1', hold: '2', revert: '1' }],
      [{
        rank_observations: '5', latest_rank_date: '2026-08-28', sqp_rows: '9', latest_sqp_week: '2026-08-17',
        sqp_impression_shares: '9', sqp_click_shares: '8', sqp_purchase_shares: '7', stock_signals: '1', latest_stock_week: '2026-08-17',
      }],
      [{
        run_id: 'run', blocked_out_of_stock: '1', skipped_inactive: '2', skipped_missing_strategy: '3',
        corridors_available: '4', corridors_missing: '5', precondition_notes: '6',
      }],
    ];
    const sql = vi.fn(() => Promise.resolve(results.shift())) as unknown as DbHandle['sql'];

    const result = await readStrategyEvidence({ sql }, { orgId: 'org', profileId: 'profile' });

    expect(sql).toHaveBeenCalledTimes(5);
    expect(result.coverage[0]).toMatchObject({ source: 'sp_api', missingDates: ['2026-07-19'] });
    expect(result.batches[0]).toMatchObject({ rows: 3, optGroup: 'Profit' });
    expect(result.observations).toEqual({ total: 4, synchronized: 3, settling: 1, complete: 2, supportedLift: 1, hold: 2, revert: 1 });
    expect(result.knowledge).toMatchObject({ rankObservations: 5, sqpPurchaseShares: 7, stockSignals: 1 });
    expect(result.diagnostics).toMatchObject({ runId: 'run', blockedOutOfStock: 1, preconditionNotes: 6 });
  });

  it('returns honest empty summaries when no optional evidence exists', async () => {
    const results: unknown[] = [[], [], [], [{}], []];
    const sql = vi.fn(() => Promise.resolve(results.shift())) as unknown as DbHandle['sql'];

    const result = await readStrategyEvidence({ sql }, { orgId: 'org', profileId: 'profile' });

    expect(result.coverage).toEqual([]);
    expect(result.batches).toEqual([]);
    expect(result.observations.total).toBe(0);
    expect(result.knowledge.sqpRows).toBe(0);
    expect(result.diagnostics).toBeNull();
  });
});

it('reads a real non-Ads coverage observation without replacing unknown settlement with zero', async () => {
  const database = await createTestDatabase('coverage_strategy');
  try {
    const [org] = await database.sql<{ id: string }[]>`
      select app.seed_tenant_fixture('coverage-strategy', '00000000-0000-4000-8000-000000000256'::uuid) as id
    `;
    const orgId = org!.id;
    const [profile] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgId} limit 1
    `;
    const profileId = profile!.id;
    await database.sql`delete from public.report_coverage where profile_id = ${profileId}`;
    expect((await readStrategyEvidence(database, { orgId, profileId })).coverage).toEqual([]);
    await upsertReportCoverage(database, {
      orgId, profileId, source: 'selling_partner_api', reportType: 'sales_and_traffic', grain: 'asin',
      status: 'complete', earliestDate: '2026-08-10', coveredThrough: '2026-08-12', settledThrough: null,
      sourceRows: 3, parsedRows: 3, loadedRows: 3, refusedRows: 0, countsMatch: true,
      observedAt: '2026-08-14T08:00:00.000Z',
    }, 3);
    const evidence = await readStrategyEvidence(database, { orgId, profileId });
    expect(evidence.coverage).toHaveLength(1);
    expect(evidence.coverage[0]).toMatchObject({
      source: 'selling_partner_api', latestLoadedDate: '2026-08-12', latestSettledDate: null,
    });
  } finally { await database.drop(); }
}, 120_000);
