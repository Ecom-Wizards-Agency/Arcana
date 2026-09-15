import type { OptimizationGroupPerformance } from '@wizard-ads/shared';
export const performance: OptimizationGroupPerformance = {
  groupId: '11111111-1111-4111-8111-111111111111', campaignIds: ['synthetic-campaign'],
  current: { start: '2026-08-10', end: '2026-08-11', metrics: { spend: 12, sales: 60, orders: 3, acos: .2 } },
  previous: { start: '2026-08-08', end: '2026-08-09', metrics: { spend: 9, sales: 45, orders: 2, acos: .2 } },
  days: [{ date: '2026-08-10', spend: 5, sales: 25, orders: 1, acos: .2 }, { date: '2026-08-11', spend: 7, sales: 35, orders: 2, acos: .2 }], reportingRows: 2, previousReportingRows: 2,
};
export const unavailablePerformance: OptimizationGroupPerformance = { ...performance,
  current: { ...performance.current, metrics: { spend: null, sales: null, orders: null, acos: null } }, previous: { ...performance.previous, metrics: { spend: null, sales: null, orders: null, acos: null } },
  days: [], reportingRows: 0, previousReportingRows: 0,
};
