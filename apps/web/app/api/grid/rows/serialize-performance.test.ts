import { describe, expect, it } from 'vitest';
import { decodeGridRowColumns, decodeGridPerformance, type GridPerformanceEvidence } from '@wizard-ads/shared';
import { columnsFor } from '@wizard-ads/ui';
import type { GridRow } from '@wizard-ads/ui';
import { serializeGridPayloadWithinBudget, GRID_RESPONSE_BODY_BUDGET_BYTES } from './serialize';
describe('full Targets transport completeness', () => {
  it('delivers all 3597 targets with measured comparisons and full observed histories under the unchanged byte budget', () => {
    const rows: GridRow[] = Array.from({ length: 3597 }, (_, index) => ({ id: `target:synthetic-${index}`, dimensions: { ...Object.fromEntries(columnsFor('targets').filter((column) => column.kind === 'dimension').map((column) => [column.id, null])), campaign_id: 'synthetic-campaign', ad_group_id: 'synthetic-group', campaign_name: 'Synthetic campaign with a measured comparison', ad_group_name: 'Synthetic ad group', targeting: `Synthetic target ${index}`, target_id: `synthetic-${index}`, asin: 'B000SYN001', verdict: 'Insufficient evidence', verdict_reason: 'no threshold configured', suggested_bid: null, market_cvr: null }, totals: { spend: 4.5, sales: 10, clicks: 2, orders: 1, units: 1, impressions: 100 }, comparison: { spend: 3.4, sales: 11, clicks: 4, orders: 2, units: 3, impressions: 123 }, currencyCode: 'USD' }));
    const days = Array.from({ length: 14 }, (_, index) => ({ date: `2026-07-${String(index + 1).padStart(2, '0')}`, observed: true, rank: index === 0 ? null : index }));
    const evidence: GridPerformanceEvidence = { feeds: [], unattributed: null, rankDays: Object.fromEntries(rows.map((row) => [row.id, days])) };
    const serialized = serializeGridPayloadWithinBudget({ rows, rowCount: rows.length, truncated: false, performance: evidence });
    expect(serialized.byteLength).toBeLessThanOrEqual(GRID_RESPONSE_BODY_BUDGET_BYTES);
    const wire = JSON.parse(serialized.body);
    expect(wire.rowColumns).toBeDefined();
    expect(decodeGridRowColumns(wire.rowColumns)).toEqual(rows);
    expect(wire.rowCount).toBe(rows.length);
    expect(wire.truncated).toBe(false);
    expect(wire.performance.rankAxis).toHaveLength(14);
    expect(wire.performance.rankDays).toBeUndefined();
    expect(decodeGridPerformance(wire.performance)).toEqual(evidence);
  });
});
