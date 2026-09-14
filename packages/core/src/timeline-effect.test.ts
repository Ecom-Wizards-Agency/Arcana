import { describe, expect, it } from 'vitest';
import type { TimelineDaily, TimelineEvent } from '@wizard-ads/shared';
import { MIN_TIMELINE_CALIBRATION_FORTNIGHTS, timelineDelta, timelineEffect, timelineNoiseFloor, timelinePretrend, timelineSummary, timelineTotals, timelineValue, shiftTimelineDate } from './timeline-effect.js';
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
        expect(noise.samples[0]?.change).toBe(.2);
        expect(noise.value).toBeNull();
        expect(noise.calibration.coverage).toBe('2 of 3 fortnights');
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

it.each([0, 14, 28, 41, 42, 56])('requires three independent calibration fortnights with %i prior days', (count) => {
    const start = '2026-07-29';
    const target = { ...event, start, end: shiftTimelineDate(start, 6) };
    const history = Array.from({ length: count }, (_, i) => day(shiftTimelineDate(start, i - count)));
    const during = Array.from({ length: 7 }, (_, i) => day(shiftTimelineDate(start, i)));
    const series = [...history, ...during];
    const result = timelineEffect({ ...input, event: target, events: [target], profile: series,
        treated: series.map((row) => ({ ...row, spend: row.date >= start ? 200 : 100 })), rangeEnd: target.end });
    expect(MIN_TIMELINE_CALIBRATION_FORTNIGHTS).toBe(3);
    expect(result.noise.calibration.observed).toBe(Math.floor(count / 14));
    expect(result.noise.calibration.coverage).toBe(`${Math.floor(count / 14)} of 3 fortnights`);
    const blocks = result.noise.calibration.fortnights;
    expect(blocks.every((block, i) => i === 0 || block.start > blocks[i - 1]!.end)).toBe(true);
    expect(result.read).toBe(count >= 42 ? 'Readable' : 'Insufficient evidence');
    if (count < 42) {
        expect(result.noise.value).toBeNull();
        expect(result.reasons).toContain(`Insufficient account calibration history: ${Math.floor(count / 14)} of 3 fortnights`);
    }
    if (count === 28) {
        expect(result.noise.samples).toHaveLength(1);
        expect(result.netDelta).toBe(1);
    }
    if (count === 41) expect(result.noise.samples.length).toBeGreaterThan(3);
});
it('does not count incomplete, unknown or event-contaminated fortnights as calibration', () => {
    const rows = Array.from({ length: 42 }, (_, i) => day(shiftTimelineDate('2026-06-01', i)));
    const contaminated = { ...event, start: rows[14]!.date, end: rows[27]!.date };
    for (const noise of [
        timelineNoiseFloor(rows.filter((_, i) => i !== 20), 'spend', [], '2026-08-01'),
        timelineNoiseFloor(rows.map((row, i) => i === 20 ? { ...row, spend: null } : row), 'spend', [], '2026-08-01'),
        timelineNoiseFloor(rows, 'spend', [contaminated], '2026-08-01'),
    ]) {
        expect(noise.calibration.coverage).toBe('2 of 3 fortnights');
        expect(noise.value).toBeNull();
    }
});
it.each([
    ['2026-07-22', '2026-07-28', ['baseline']],
    ['2026-07-28', '2026-07-30', ['baseline', 'treatment']],
    ['2026-07-29', '2026-08-04', ['treatment']],
    ['2026-07-22', null, ['baseline', 'treatment']],
])('names confounding over %s → %s in the READ label and evidence', (start, end, periods) => {
    const target = { ...event, start: '2026-07-29', end: '2026-08-04' };
    const coupon: TimelineEvent = { ...event, id: 'baseline-coupon', name: 'Synthetic promotion', kind: 'promotion', start, end };
    const series = Array.from({ length: 126 }, (_, i) => day(shiftTimelineDate('2026-04-01', i)));
    const result = timelineEffect({ ...input, event: target, events: [target, coupon], profile: series,
        treated: series.map((row) => ({ ...row, spend: row.date >= target.start ? 200 : 100 })), rangeEnd: target.end });
    expect(result.netDelta).toBe(1);
    expect(result.noise.value).toBe(0);
    expect(result.read).toBe(`Confounded by Synthetic promotion${periods.includes('baseline') ? ' (baseline)' : ''}`);
    expect(result.overlapIds).toEqual([coupon.id]);
    expect(result.evidence.confounders.map((item) => item.period)).toEqual(periods);
    expect(result.evidence.confounders.every((item) => item.eventId === coupon.id && item.start === start && item.end === end)).toBe(true);
    for (const period of periods) expect(result.reasons.join(' ')).toContain(`${period === 'baseline' ? 'Baseline' : 'Treatment'} contaminated by Synthetic promotion`);
});
it('keeps baseline contamination visible even when calibration is insufficient', () => {
    const coupon = { ...event, id: 'baseline-coupon', name: 'Synthetic promotion', start: '2026-07-25', end: '2026-07-31' };
    const result = timelineEffect({ ...input, profile: profile.filter((row) => row.date >= '2026-07-01'),
        treated: treated.filter((row) => row.date >= '2026-07-01'), events: [event, coupon] });
    expect(result.read).toBe('Insufficient evidence · baseline confounded by Synthetic promotion');
    expect(result.evidence.confounders[0]?.period).toBe('baseline');
    expect(result.reasons.join(' ')).toContain('Insufficient account calibration history');
});
it('excludes events outside both comparison periods from confounding', () => {
    const result = timelineEffect({ ...input, events: [event,
        { ...event, id: 'earlier', start: '2026-07-23', end: '2026-07-24' },
        { ...event, id: 'later', start: '2026-08-08', end: null }] });
    expect(result.read).toBe('Readable');
    expect(result.overlapIds).toEqual([]);
    expect(result.evidence.confounders).toEqual([]);
});
