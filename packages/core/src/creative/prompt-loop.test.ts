import { expect, it } from 'vitest';
import type { SponsoredPrompt, SponsoredPromptSnapshot } from '@wizard-ads/shared';
import { analyzeSponsoredPrompts } from './prompt-loop.js';
const at = (day: number) => `2026-06-${String(day).padStart(2, '0')}T00:00:00.000Z`;
const prompt: SponsoredPrompt = { id: '00000000-0000-4000-8000-000000000001', campaignId: 'synthetic-campaign', adGroupId: 'synthetic-group', adProduct: 'SB', campaignName: null, adGroupName: null,
  promptText: 'Synthetic prompt', normalizedPrompt: 'synthetic prompt', firstSeenAt: at(2), lastSeenAt: at(6), currentStatus: 'live',
  observations: ['live', 'paused', 'live', 'paused', 'live'].map((status, index) => ({ status: status as 'live' | 'paused', observedAt: at(index + 2), intervalStart: at(index + 1), intervalEnd: at(index + 2), spend: 3, sales: 6, clicks: 2, orders: 1 })) };
const snapshot: SponsoredPromptSnapshot = { profileId: prompt.id, viewedThrough: at(7), windowStart: '2026-05-08T00:00:00.000Z', windowEnd: at(7), lastVisitedAt: at(3), latestObservationAt: at(6), prompts: [prompt] };
it('detects returns and computes pause counts, repeated returns, ACOS and pause spacing', () => {
  const result = analyzeSponsoredPrompts(snapshot);
  expect(result.changed[0]).toMatchObject({ change: 'returned', returnedAt: at(6), spend: 15, acos: 0.5 });
  expect(result.loop).toEqual({ pausedPrompts: 1, returnedPrompts: 1, returns: 2, meanReturnsPerPausedPrompt: 2, meanDaysBetweenPauses: 2 });
  expect(result.sinceVisit?.spend).toBe(9);
});
it('partitions each snapshot by its user visit and supports first visits', () => {
  expect(analyzeSponsoredPrompts({ ...snapshot, lastVisitedAt: at(7) }).unchanged).toHaveLength(1);
  expect(analyzeSponsoredPrompts({ ...snapshot, lastVisitedAt: null }).sinceVisit).toBeNull();
  const fresh = { ...prompt, observations: prompt.observations.slice(0, 1) };
  expect(analyzeSponsoredPrompts({ ...snapshot, prompts: [fresh], lastVisitedAt: null }).changed[0]?.change).toBe('newly_sponsored');
});
it('preserves missing metrics and does not prorate an interval crossing a cutoff', () => {
  const result = analyzeSponsoredPrompts({ ...snapshot, lastVisitedAt: '2026-06-03T12:00:00.000Z', prompts: [{ ...prompt, observations: prompt.observations.map((row) => ({ ...row, sales: null })) }] });
  expect(result.changed[0]?.sales).toBeNull(); expect(result.changed[0]?.acos).toBeNull(); expect(result.sinceVisit?.spend).toBeNull();
  expect(analyzeSponsoredPrompts({ ...snapshot, prompts: [] }).thirtyDays.spend).toBeNull();
});
it('uses complete calendar windows without cutting a daily export at the visit clock time', () => {
  const result = analyzeSponsoredPrompts({ ...snapshot, viewedThrough: '2026-06-07T12:34:56.000Z' });
  expect(result.thirtyDays.spend).toBe(15);
  expect(result.thirtyDays.sales).toBe(30);
});
