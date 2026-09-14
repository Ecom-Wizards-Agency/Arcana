/** Replayable timeline arithmetic. No I/O, interpolated days, or tenant defaults. */
import type { TimelineDaily, TimelineEvent, TimelineEvidenceSettings, TimelineFocus } from '@wizard-ads/shared';
export const shiftTimelineDate = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
export function timelineDates(start: string, end: string): string[] {
    const count = Math.floor((Date.parse(end) - Date.parse(start)) / 86400000) + 1;
    return Array.from({ length: Math.max(0, count) }, (_, i) => shiftTimelineDate(start, i));
}
const between = (days: readonly TimelineDaily[], start: string, end: string) => days.filter((day) => day.date >= start && day.date <= end);
const baseKeys = ['spend', 'sales', 'clicks', 'orders', 'impressions'] as const;
export function timelineTotals(days: readonly TimelineDaily[]): Omit<TimelineDaily, 'date'> {
    return Object.fromEntries(baseKeys.map((key) => [key, !days.length || days.some((day) => day[key] === null) ? null : days.reduce((sum, day) => sum + day[key]!, 0)])) as Omit<TimelineDaily, 'date'>;
}
export function timelineValue(days: readonly TimelineDaily[], measure: TimelineFocus, dailyMean = false): number | null {
    const totals = timelineTotals(days);
    const ratio = (a: number | null, b: number | null) => a === null || b === null || b <= 0 ? null : a / b;
    if (measure === 'share')
        return null;
    if (measure === 'acos')
        return ratio(totals.spend, totals.sales);
    if (measure === 'cvr')
        return ratio(totals.orders, totals.clicks);
    if (measure === 'ctr')
        return ratio(totals.clicks, totals.impressions);
    const value = totals[measure];
    return value === null ? null : dailyMean ? value / days.length : value;
}
export function timelineDelta(before: number | null, after: number | null): number | null {
    return before === null || after === null || before === 0 ? null : (after - before) / Math.abs(before);
}
export function timelineSummary(days: readonly TimelineDaily[], start: string, end: string, measure: TimelineFocus) {
    const dates = timelineDates(start, end);
    const split = dates[Math.floor(dates.length / 2)] ?? end;
    const first = between(days, start, shiftTimelineDate(split, -1));
    const second = between(days, split, end);
    return { value: timelineValue([...first, ...second], measure),
        delta: timelineDelta(timelineValue(first, measure, true), timelineValue(second, measure, true)),
        first: { dates: first.map((d) => d.date), value: timelineValue(first, measure, true) },
        second: { dates: second.map((d) => d.date), value: timelineValue(second, measure, true) } };
}
const overlaps = (event: Pick<TimelineEvent, 'start' | 'end'>, start: string, end: string) => event.start <= end && (event.end === null || event.end >= start);
/** Conservative empirical floor: largest absolute clean adjacent-fortnight change. Returns the distribution as evidence. */
export function timelineNoiseFloor(days: readonly TimelineDaily[], measure: TimelineFocus, events: readonly TimelineEvent[], beforeDate: string) {
    const sorted = [...days].filter((day) => day.date < beforeDate).sort((a, b) => a.date.localeCompare(b.date));
    const samples: {
        start: string;
        end: string;
        change: number;
    }[] = [];
    for (const day of sorted) {
        const end = shiftTimelineDate(day.date, 27);
        if (end >= beforeDate || events.some((event) => overlaps(event, day.date, end)))
            continue;
        const first = between(sorted, day.date, shiftTimelineDate(day.date, 13));
        const second = between(sorted, shiftTimelineDate(day.date, 14), end);
        if (new Set(first.map((d) => d.date)).size !== 14 || new Set(second.map((d) => d.date)).size !== 14)
            continue;
        const change = timelineDelta(timelineValue(first, measure), timelineValue(second, measure));
        if (change !== null)
            samples.push({ start: day.date, end, change });
    }
    return { value: samples.length ? Math.max(...samples.map((sample) => Math.abs(sample.change))) : null, samples };
}
export function timelineEffect(input: {
    event: TimelineEvent;
    profile: readonly TimelineDaily[];
    treated: readonly TimelineDaily[];
    events: readonly TimelineEvent[];
    settings: TimelineEvidenceSettings;
    rangeEnd: string;
}) {
    const { event, profile, treated, events, settings } = input;
    const end = event.end === null || event.end > input.rangeEnd ? input.rangeEnd : event.end;
    const baselineStart = shiftTimelineDate(event.start, -7);
    const baselineEnd = shiftTimelineDate(event.start, -1);
    const treatedBefore = between(treated, baselineStart, baselineEnd);
    const treatedDuring = between(treated, event.start, end);
    // The account control uses the same calendar periods, even for recorded-only scopes.
    const beforeDates = new Set(treatedBefore.map((day) => day.date));
    const duringDates = new Set(treatedDuring.map((day) => day.date));
    const accountBefore = between(profile, baselineStart, baselineEnd);
    const accountDuring = between(profile, event.start, end);
    const delta = (before: readonly TimelineDaily[], during: readonly TimelineDaily[]) => timelineDelta(timelineValue(before, event.focus, true), timelineValue(during, event.focus, true));
    const treatedDelta = delta(treatedBefore, treatedDuring);
    const accountDelta = delta(accountBefore, accountDuring);
    const netDelta = treatedDelta === null || accountDelta === null ? null : treatedDelta - accountDelta;
    const noise = timelineNoiseFloor(profile, event.focus, events, event.start);
    const overlap = events.filter((other) => other.id !== event.id && overlaps(other, event.start, end));
    const reasons: string[] = [];
    if (settings.minDays === null)
        reasons.push('Missing setting: minimum observed days');
    if (settings.minClicks === null)
        reasons.push('Missing setting: minimum treated clicks');
    if (!treated.length)
        reasons.push('No measured campaign, ad group or target scope');
    if (event.focus === 'share')
        reasons.push('Share is not measured by advertising daily facts');
    if (settings.minDays !== null && (treatedBefore.length < settings.minDays || treatedDuring.length < settings.minDays))
        reasons.push('Too few observed days before or during the event');
    if (settings.minClicks !== null && [treatedBefore, treatedDuring].some((days) => { const clicks = timelineTotals(days).clicks; return clicks === null || clicks < settings.minClicks!; }))
        reasons.push('Too few treated clicks before or during the event');
    if (treated.length && (accountBefore.length !== treatedBefore.length || accountDuring.length !== treatedDuring.length || accountBefore.some((day) => !beforeDates.has(day.date)) || accountDuring.some((day) => !duringDates.has(day.date))))
        reasons.push('Account and treated facts do not cover the same dates');
    if (netDelta === null)
        reasons.push('Missing or zero baseline denominator');
    if (noise.value === null)
        reasons.push('No complete clean fortnight comparison in account history');
    const read = reasons.length ? 'Insufficient evidence' : overlap.length ? `Confounded by ${overlap.map((other) => other.name).join(', ')}` : Math.abs(netDelta!) > noise.value! ? 'Readable' : 'Within account noise';
    return { treatedDelta, accountDelta, netDelta, noise, read, reasons, overlapIds: overlap.map((other) => other.id),
        evidence: { baselineStart, baselineEnd, start: event.start, end, treatedBefore, treatedDuring, accountBefore, accountDuring } };
}
/** OLS uses calendar offsets so gaps never compress the time axis. */
function slope(days: readonly TimelineDaily[], measure: TimelineFocus): number | null {
    const points = days.flatMap((day) => { const y = timelineValue([day], measure); return y === null ? [] : [{ x: Date.parse(day.date) / 86400000, y }]; });
    if (points.length < 2)
        return null;
    const meanX = points.reduce((sum, p) => sum + p.x, 0) / points.length;
    const meanY = points.reduce((sum, p) => sum + p.y, 0) / points.length;
    const denominator = points.reduce((sum, p) => sum + (p.x - meanX) ** 2, 0);
    return denominator === 0 ? null : points.reduce((sum, p) => sum + (p.x - meanX) * (p.y - meanY), 0) / denominator;
}
export function timelinePretrend(days: readonly TimelineDaily[], event: TimelineEvent, rangeEnd: string, measure: TimelineFocus = 'spend') {
    const before = slope(between(days, shiftTimelineDate(event.start, -7), shiftTimelineDate(event.start, -1)), measure);
    const inside = slope(between(days, event.start, event.end ?? rangeEnd), measure);
    const preexisting = before !== null && inside !== null && before * inside > 0 && Math.abs(before) >= Math.abs(inside);
    return { beforeSlope: before, insideSlope: inside, verdict: before === null || inside === null ? 'Insufficient observations to compare trends' : preexisting ? `${measure === 'spend' ? 'Spend' : measure} was already ${before < 0 ? 'falling' : 'rising'} before this experiment started` : 'The margin does not establish a pre-existing trend' };
}
