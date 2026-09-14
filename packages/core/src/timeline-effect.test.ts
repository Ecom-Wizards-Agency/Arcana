import { describe, expect, it } from 'vitest';
import type { TimelineDaily, TimelineEvent } from '@wizard-ads/shared';
import { timelineDelta, timelineEffect, timelineNoiseFloor, timelinePretrend, timelineSummary, timelineTotals, timelineValue, shiftTimelineDate } from './timeline-effect.js';
const day = (date: string, spend = 100, sales = 200): TimelineDaily => ({ date, spend, sales, clicks: 20, orders: 4, impressions: 100 });
const event: TimelineEvent = { id: 'synthetic-experiment', name: 'Bid experiment', kind: 'experiment', start: '2026-08-01', end: '2026-08-07', status: 'ended', scope: { campaignIds: ['synthetic-campaign'] }, scopeText: 'One campaign', focus: 'spend', note: 'Synthetic hypothesis', actorId: null, createdAt: '2026-08-01T00:00:00Z', supersedesId: null };
const profile = Array.from({ length: 70 }, (_, i) => day(shiftTimelineDate('2026-06-01', i)));
const treated = profile.map((row) => ({ ...row, spend: row.date >= '2026-08-01' ? 150 : 100 }));
const input = { event, profile, treated, events: [event], settings: { minDays: 2, minClicks: 1 }, rangeEnd: '2026-08-07' };
describe('timeline effect evidence', () => {
    it('recomputes ratios from sums and compares calendar halves using daily means', () => {
        const rows = [day('2026-07-01', 10, 100), day('2026-07-02', 30, 100), day('2026-07-03', 20, 400), day('2026-07-04', 40, 200)];
        expect(timelineValue(rows, 'acos')).toBe(100 / 800);
        expect(timelineSummary(rows, '2026-07-01', '2026-07-04', 'spend').delta).toBe(.5);
        expect(timelineSummary(rows, '2026-07-01', '2026-07-04', 'acos').delta).toBeCloseTo(-.5);
        expect(timelineValue(rows, 'cvr')).toBe(16 / 80);
        expect(timelineValue(rows, 'ctr')).toBe(80 / 400);
    });
    it('preserves null, zero denominators, absent days and unequal halves', () => {
        expect(timelineTotals([]).spend).toBeNull();
        expect(timelineValue([day('2026-07-01', 10, 0)], 'acos')).toBeNull();
        expect(timelineDelta(0, 20)).toBeNull();
        expect(timelineValue([{ ...day('2026-07-01'), spend: null }], 'spend')).toBeNull();
        expect(timelineSummary(profile, '2026-06-01', '2026-06-05', 'spend').delta).toBe(0);
    });
    it.each([
        ['Readable', input],
        ['Confounded by Coupon 15%', { ...input, events: [event, { ...event, id: 'coupon', name: 'Coupon 15%', kind: 'promotion' as const }] }],
        ['Insufficient evidence', { ...input, settings: { minDays: null, minClicks: null } }],
        ['Insufficient evidence', { ...input, treated: [] }],
        ['Within account noise', { ...input, treated: profile }],
    ])('classifies %s with traceable periods', (read, value) => { const result = timelineEffect(value); expect(result.read).toBe(read); expect(result.evidence.baselineStart).toBe('2026-07-25'); expect(result.evidence.baselineEnd).toBe('2026-07-31'); });
    it('names missing settings and derives net from treated and account', () => {
        const effect = timelineEffect(input);
        expect(effect.treatedDelta).toBe(.5);
        expect(effect.accountDelta).toBe(0);
        expect(timelineEffect({ ...input, treated: [] }).accountDelta).toBe(0);
        expect(effect.netDelta).toBe(.5);
        expect(effect.noise.value).toBe(0);
        expect(effect.noise.samples.length).toBeGreaterThan(0);
        expect(timelineEffect({ ...input, settings: { minDays: null, minClicks: null } }).reasons).toContain('Missing setting: minimum observed days');
    });
    it('derives noise only from complete, clean, prior account fortnights', () => {
        const rows = Array.from({ length: 28 }, (_, i) => day(shiftTimelineDate('2026-06-01', i), i < 14 ? 100 : 120));
        const noise = timelineNoiseFloor(rows, 'spend', [], '2026-07-01');
        expect(noise.samples).toHaveLength(1);
        expect(noise.value).toBe(.2);
        expect(timelineNoiseFloor(rows.slice(1), 'spend', [], '2026-07-01').value).toBeNull();
        expect(timelineNoiseFloor(rows, 'spend', [{ ...event, start: '2026-06-10', end: '2026-06-11' }], '2026-07-01').value).toBeNull();
    });
    it('detects a pre-existing decline using calendar slopes without invented values', () => {
        const rows = Array.from({ length: 14 }, (_, i) => day(shiftTimelineDate('2026-07-25', i), 200 - i * 5));
        const verdict = timelinePretrend(rows, event, '2026-08-07');
        expect(verdict.beforeSlope).toBe(-5);
        expect(verdict.insideSlope).toBe(-5);
        expect(verdict.verdict).toBe('Spend was already falling before this experiment started');
        expect(timelinePretrend([], event, '2026-08-07').verdict).toContain('Insufficient');
    });
});
