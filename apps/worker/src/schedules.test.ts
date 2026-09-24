import { CORE_REPORT_FAMILIES, CoreFeatureReportType } from '@wizard-ads/shared';
import { coreFamilySchedules } from './schedules.js';
import { describe, expect, it } from 'vitest';
import { MAX_REPORT_RANGE_DAYS } from '@wizard-ads/ads-api';
import { defaultSchedules } from './schedules.js';

describe('defaultSchedules comparison coverage', () => {
  it('uses two contiguous legal-size blocks for current and comparison facts', () => {
    const reports = defaultSchedules(['spCampaigns']).filter(
      (schedule) => schedule.jobType === 'report.request',
    );
    expect(reports.map((schedule) => ({
      variant: schedule.variant,
      lookbackDays: schedule.lookbackDays,
      windowOffsetDays: schedule.windowOffsetDays,
    }))).toEqual([
      { variant: 'default', lookbackDays: 3, windowOffsetDays: 0 },
      { variant: 'restatement', lookbackDays: 32, windowOffsetDays: 0 },
      { variant: 'comparison', lookbackDays: 32, windowOffsetDays: 32 },
    ]);
    for (const schedule of reports) {
      expect((schedule.lookbackDays ?? 1) - 1).toBeLessThanOrEqual(MAX_REPORT_RANGE_DAYS);
    }
  });
});

it('provisions exactly three disabled, bounded schedules for each opted-in family candidate', () => {
  const schedules = coreFamilySchedules();
  expect(schedules).toHaveLength(72);
  expect(new Set(schedules.map((s) => s.reportType)).size).toBe(CoreFeatureReportType.options.length);
  for (const s of schedules) {
    const policy = CORE_REPORT_FAMILIES[s.reportType];
    expect(s.enabled).toBe(false);
    expect(s.lookbackDays - 1).toBeLessThanOrEqual(policy.maximumDateDifferenceDays);
    expect(s.lookbackDays + s.windowOffsetDays).toBeLessThanOrEqual(policy.retentionDays);
    expect(s.lookbackDays).toBeLessThanOrEqual(32);
  }
  expect(defaultSchedules().filter((s) => s.jobType === 'report.request')).toHaveLength(18);
  expect(defaultSchedules().some((s) => CoreFeatureReportType.safeParse(s.reportType).success)).toBe(false);
});
