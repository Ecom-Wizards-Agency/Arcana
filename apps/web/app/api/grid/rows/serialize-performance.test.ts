import { describe, expect, it } from 'vitest';
import { decodeGridPerformance, type GridPerformanceEvidence } from '@wizard-ads/shared';
import type { GridRow } from '@wizard-ads/ui';
import { serializeGridPayloadWithinBudget, GRID_RESPONSE_BODY_BUDGET_BYTES } from './serialize';
describe('full Targets transport completeness', () => {
  it('delivers all 3597 targets with full observed histories under the unchanged byte budget', () => {
    const rows: GridRow[] = Array.from({ length: 3597 }, (_, index) => ({ id: `target:synthetic-${index}`, dimensions: { targeting: `Synthetic target ${index}`, target_id: `synthetic-${index}`, asin: 'B000SYN001', verdict: 'Insufficient evidence', verdict_reason: 'no threshold configured', suggested_bid: null, market_cvr: null }, totals: { spend: 4.5, sales: 10, clicks: 2, orders: 1, units: 1, impressions: 100 }, comparison: null, currencyCode: 'USD' }));
    const days = Array.from({ length: 14 }, (_, index) => ({ date: `2026-07-${String(index + 1).padStart(2, '0')}`, observed: true, rank: index === 0 ? null : index }));
    const evidence: GridPerformanceEvidence = { feeds: [], unattributed: null, rankDays: Object.fromEntries(rows.map((row) => [row.id, days])) };
    const serialized = serializeGridPayloadWithinBudget({ rows, rowCount: rows.length, truncated: false, performance: evidence });
    expect(serialized.byteLength).toBeLessThanOrEqual(GRID_RESPONSE_BODY_BUDGET_BYTES);
    const wire = JSON.parse(serialized.body);
    expect(wire.rows).toHaveLength(rows.length);
    expect(wire.rowCount).toBe(rows.length);
    expect(wire.truncated).toBe(false);
    expect(wire.performance.rankAxis).toHaveLength(14);
    expect(wire.performance.rankDays).toBeUndefined();
    expect(decodeGridPerformance(wire.performance)).toEqual(evidence);
  });
});
