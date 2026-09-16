import { describe, expect, it } from 'vitest';
import { CORE_REPORT_FAMILIES, CoreFeatureReportType } from '@wizard-ads/shared';
import { assertCoreReportAdmission, defaultCoreReportConfiguration, parseCoreReport, validateCoreReportWindow } from './report-families.js';
import { buildReportRequestBody } from './reports.js';

describe('audit-v1 synthetic report family fixtures', () => {
  for (const family of CoreFeatureReportType.options) for (const timeUnit of ['DAILY', 'SUMMARY'] as const) {
    it(`${family}/${timeUnit}: reconciles identities, null, zero, duplicates and refusal`, () => {
      const spec = CORE_REPORT_FAMILIES[family];
      const configuration = defaultCoreReportConfiguration(family, timeUnit);
      const fixture = { date: '2026-09-01', startDate: '2026-09-01', endDate: '2026-09-02', ...Object.fromEntries(spec.required.map((key) => [key, `synthetic-${key}`])), [spec.defaultMetrics[0]!]: 0 };
      const parsed = parseCoreReport(configuration, [fixture, fixture, { ...fixture, campaignId: null }, { ...fixture, campaignId: 'second', [spec.defaultMetrics[0]!]: null }], '2026-09-01', '2026-09-02');
      expect(parsed).toMatchObject({ sourceRows: 4, parsedRows: 3, duplicateRows: 1 });
      expect(parsed.rows).toHaveLength(2);
      expect(parsed.refusals).toEqual([{ index: 2, reason: 'invalid_dimension' }]);
      expect(parsed.rows[0]?.metrics[spec.defaultMetrics[0]!]).toBe(0);
      expect(parsed.rows[1]?.metrics[spec.defaultMetrics[0]!]).toBeNull();
      const request = buildReportRequestBody({ reportType: family, startDate: '2026-09-01', endDate: '2026-09-02', familyConfiguration: configuration });
      expect(request['configuration']).toMatchObject({ reportTypeId: spec.reportTypeId, groupBy: [spec.groupBy, ...(spec.additionalGroupBy ?? [])], timeUnit });
      expect(() => buildReportRequestBody({ reportType: family, startDate: '2026-09-01', endDate: '2026-09-02', columns: ['date', 'cost'] })).toThrow();
    });
  }
  it.each([['sbTargeting', 60], ['sdTargeting', 65], ['spAdvertisedProduct', 95], ['spGrossAndInvalids', 365], ['sbPurchasedProduct', 731]] as const)('%s separates retention from inclusive row counts', (family, retention) => {
    const configuration = defaultCoreReportConfiguration(family);
    const today = '2026-09-15';
    const start = new Date(Date.parse(today) - retention * 86_400_000).toISOString().slice(0, 10);
    expect(() => validateCoreReportWindow(configuration, start, start, today)).not.toThrow();
    const expired = new Date(Date.parse(start) - 86_400_000).toISOString().slice(0, 10);
    expect(() => validateCoreReportWindow(configuration, expired, expired, today)).toThrow(/retention/);
    const end = new Date(Date.parse(start) + CORE_REPORT_FAMILIES[family].maximumDateDifferenceDays * 86_400_000).toISOString().slice(0, 10);
    expect(() => validateCoreReportWindow(configuration, start, end)).not.toThrow();
    const beyond = new Date(Date.parse(end) + 86_400_000).toISOString().slice(0, 10);
    expect(() => validateCoreReportWindow(configuration, start, beyond)).toThrow(/range/);
  });
  it('requires opt-in, recovery and SB preview evidence before any provider call', () => {
    const configuration = defaultCoreReportConfiguration('sbPurchasedProduct');
    const scope = { orgId: 'synthetic-org', profileId: 'synthetic-profile' };
    expect(() => assertCoreReportAdmission(configuration, null, scope)).toThrow(/not enabled/);
    const capability = { ...scope, family: 'sbPurchasedProduct' as const, approvedConfigurations: [configuration], enabled: true, status: 'eligible' as const, marketplace: 'synthetic', recoveryGateEvidence: 'synthetic-evidence', sbMultiAdGroupsEnabled: null, multiTouchEvidence: null, observedAt: '2026-09-01T00:00:00.000Z' };
    expect(() => assertCoreReportAdmission(configuration, capability, scope)).toThrow(/preview/);
    expect(() => assertCoreReportAdmission(configuration, { ...capability, sbMultiAdGroupsEnabled: true }, scope)).not.toThrow();
  });
  it('never relabels legacy provider columns as multi-touch even with an approval record', () => {
    const configuration = { ...defaultCoreReportConfiguration('spCampaignMetrics'), attributionGeneration: 'multi_touch_v1' as const };
    const scope = { orgId: 'synthetic-org', profileId: 'synthetic-profile' };
    expect(() => assertCoreReportAdmission(configuration, { ...scope, family: configuration.family, approvedConfigurations: [configuration], enabled: true, status: 'eligible', marketplace: 'US', recoveryGateEvidence: 'synthetic', sbMultiAdGroupsEnabled: null, multiTouchEvidence: 'synthetic', observedAt: '2026-09-01T00:00:00.000Z' }, scope)).toThrow('not pinned');
  });

  it('refuses conflicting target labels without splitting one configured target into two facts', () => {
    const configuration = defaultCoreReportConfiguration('sbTargeting');
    const row = { date: '2026-09-01', campaignId: 'c', adGroupId: 'g', keywordId: 'k', keywordText: 'first label', cost: 5 };
    const parsed = parseCoreReport(configuration, [row, { ...row, keywordText: 'changed label' }], '2026-09-01', '2026-09-01');
    expect(parsed).toMatchObject({ sourceRows: 2, parsedRows: 1, duplicateRows: 0, refusals: [{ index: 1, reason: 'conflicting_duplicate' }] });
    expect(parsed.rows).toHaveLength(1);
  });

});
