import { expect, it } from 'vitest';
import { campaignCount, formatResearchPeriod, researchAxisTicks, signedResearchPercent } from './research-format';
it.each([[0, '0 campaigns'], [1, '1 campaign'], [2, '2 campaigns']] as const)('pluralizes %i campaigns', (count, label) => {
  expect(campaignCount(count)).toBe(label);
});
it('formats same-month, cross-month and cross-year periods as calendar dates', () => {
  expect(formatResearchPeriod({ start: '2026-06-01', end: '2026-06-07' })).toBe('1 – 7 Jun 2026');
  expect(formatResearchPeriod({ start: '2026-07-30', end: '2026-08-28' })).toBe('30 Jul to 28 Aug 2026');
  expect(formatResearchPeriod({ start: '2025-12-30', end: '2026-01-02' })).toBe('30 Dec 2025 to 2 Jan 2026');
  expect(formatResearchPeriod({ start: '2026-06-01', end: '2026-06-01' })).toBe('1 Jun 2026');
  expect(formatResearchPeriod({ start: '', end: '' })).toBe('Choose a period');
});
it('derives axis ticks from the supplied maximum and signs percentage changes', () => {
  expect(researchAxisTicks(160)).toEqual([0, 40, 80, 120, 160]);
  expect(researchAxisTicks(0)).toEqual([0]);
  expect(signedResearchPercent(0.088)).toBe('+8.8%');
  expect(signedResearchPercent(-0.031)).toBe('−3.1%');
  expect(signedResearchPercent(0)).toBe('0.0%');
  expect(signedResearchPercent(-0.00001)).toBe('0.0%');
});
