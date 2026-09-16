import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CORE_REPORT_FAMILIES, type CoreReportEvidence } from '@wizard-ads/shared';
import { CoreReportEvidencePanel } from './core-report-evidence';
import { GRID_CORE_FAMILIES, coreEvidenceGridRows } from './core-report-rows';

describe('core report consumers', () => {
  const consumers = { ...GRID_CORE_FAMILIES, target360: ['sdTargetingMatchedTarget'], query_intelligence: ['sbSearchTerm'], creatives: ['sbAdMetrics'], sync_status: ['spGrossAndInvalids'] } as const;
  for (const [screen, families] of Object.entries(consumers)) for (const status of ['measured', 'partial', 'stale', 'unmeasured'] as const) {
    it(`${screen} renders counted ${status} family evidence`, () => {
      const evidence: CoreReportEvidence[] = families.map((family) => ({ family, grain: CORE_REPORT_FAMILIES[family].grain, status, rowCount: 0, truncated: status === 'partial', observedAt: status === 'unmeasured' ? null : '2026-09-02T00:00:00.000Z', rows: [] }));
      const html = renderToStaticMarkup(<CoreReportEvidencePanel evidence={evidence} />);
      expect((html.match(/data-report-family=/g) ?? []).length).toBe(families.length);
      expect((html.match(new RegExp(`data-evidence-status="${status}"`, 'g')) ?? []).length).toBe(families.length);
    });
  }
  it('keeps missing metrics missing and excludes purchased revenue from grid totals', () => {
    const evidence: CoreReportEvidence = { family: 'sbAdGroup', grain: 'ad_group', status: 'partial', rowCount: 1, truncated: false, observedAt: null, rows: [{ family: 'sbAdGroup', timeUnit: 'DAILY', periodStart: '2026-09-01', periodEnd: '2026-09-01', attributionGeneration: 'legacy', identityResolution: 'reported_unresolved', dimensions: { campaignId: 'c', adGroupId: 'g' }, metrics: { cost: 0, sales: null } }] };
    const rows = coreEvidenceGridRows([evidence], 'USD');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.measurement?.missing).toContain('sales');
    expect(rows[0]?.measurement?.missing).not.toContain('spend');
    expect(coreEvidenceGridRows([{ ...evidence, family: 'sbPurchasedProduct', grain: 'purchased_product' }], 'USD')).toHaveLength(0);
  });
  it('aggregates one target across changed display labels without splitting its identity', () => {
    const evidence: CoreReportEvidence = { family: 'sbTargeting', grain: 'sb_target', status: 'measured', rowCount: 2, truncated: false, observedAt: null, rows: ['2026-09-01', '2026-09-02'].map((day, index) => ({ family: 'sbTargeting', timeUnit: 'DAILY', periodStart: day, periodEnd: day, attributionGeneration: 'legacy', identityResolution: 'reported_unresolved', dimensions: { campaignId: 'c', adGroupId: 'g', keywordId: 'k', keywordText: index ? 'changed label' : 'first label' }, metrics: { cost: index ? 3 : 2 } })) };
    const rows = coreEvidenceGridRows([evidence], 'USD');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.dimensions['target_id']).toBe('k');
    expect(rows[0]?.totals.spend).toBe(5);
  });
});
