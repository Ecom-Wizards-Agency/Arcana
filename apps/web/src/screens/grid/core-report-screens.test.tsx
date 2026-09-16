// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { CORE_REPORT_FAMILIES, type CoreFeatureReportType, type CoreReportEvidence } from '@wizard-ads/shared';
import { rendered } from '../render-test-support';
import Grid from './view';
import { ready as grid } from './render-fixture';
import Creative from '../creative/view';
import { ready as creative } from '../creative/render-fixture';
import Query from '../query-intelligence/view';
import { ready as query } from '../query-intelligence/render-fixture';
import Sync from '../sync-status/view';
import { ready as sync } from '../sync-status/render-fixture';
import Target from '../targets/view';
import { targetFixture } from '../targets/fixtures';

function evidence(family: CoreFeatureReportType, status: CoreReportEvidence['status']): CoreReportEvidence[] {
  const spec = CORE_REPORT_FAMILIES[family];
  return [{ family, grain: spec.grain, status, rowCount: status === 'unmeasured' ? 0 : 1, truncated: status === 'partial', observedAt: status === 'unmeasured' ? null : '2026-09-02T00:00:00.000Z', rows: status === 'unmeasured' ? [] : [{ family, timeUnit: 'DAILY', periodStart: '2026-09-01', periodEnd: '2026-09-01', attributionGeneration: 'legacy', identityResolution: 'reported_unresolved', dimensions: Object.fromEntries(spec.required.map((key) => [key, 'synthetic-identity'])), metrics: { [spec.defaultMetrics[0]!]: 0, [spec.defaultMetrics[1]!]: null } }] }];
}
const grids = { products: 'spAdvertisedProduct', campaigns: 'spGrossAndInvalids', ad_groups: 'sdAdGroup', targets: 'sbTargeting', search_terms: 'sbSearchTerm', placements: 'sbCampaignPlacement' } as const;
for (const status of ['measured', 'partial', 'stale', 'unmeasured'] as const) {
  for (const [entity, family] of Object.entries(grids)) it(`${entity} screen retains ${status} report evidence`, () => {
    const host = rendered(<Grid data={{ ...grid, props: { ...grid.props, entity: entity as keyof typeof grids, coreEvidence: evidence(family, status) } }} />);
    const reports = host.querySelectorAll('[data-report-family]');
    expect(reports).toHaveLength(status === 'unmeasured' ? 0 : 1);
    expect(host.querySelectorAll('[data-report-family] tbody tr')).toHaveLength(status === 'unmeasured' ? 0 : 1);
    if (status !== 'unmeasured') expect(reports[0]?.getAttribute('data-evidence-status')).toBe(status);
  });
  for (const name of ['creative', 'query', 'sync', 'target360'] as const) it(`${name} screen retains ${status} family rows at their reported scope`, () => {
    const family = { creative: 'sbAdMetrics', query: 'sbSearchTerm', sync: 'spGrossAndInvalids', target360: 'sdTargetingMatchedTarget' } as const;
    const coreEvidence = evidence(family[name], status);
    const view = name === 'creative' ? <Creative data={{ ...creative, props: { ...creative.props, coreEvidence } }} /> : name === 'query' ? <Query data={{ ...query, props: { ...query.props, coreEvidence } }} /> : name === 'sync' ? <Sync data={{ ...sync, props: { ...sync.props, coreEvidence } }} /> : <Target data={{ ...targetFixture, view: 'ready', currencyCode: 'USD', back: '/grid', savedView: null, coreEvidence }} />;
    const host = rendered(view);
    expect(host.querySelectorAll('[data-report-family]')).toHaveLength(1);
    expect(host.querySelector('[data-report-family]')?.getAttribute('data-evidence-status')).toBe(status);
    expect(host.querySelectorAll('[data-report-family] tbody tr')).toHaveLength(status === 'unmeasured' ? 0 : 1);
  });
}
