import type { CreativeChangeCertainty } from '@wizard-ads/shared';

/**
 * Daily observations are consecutive when their profile calendar dates differ
 * by at most one. A missing boundary never becomes an exact change timestamp.
 * Store this result when recording a change; reads return the saved judgement.
 */
export function creativeChangeCertainty(input: {
  previous: string | null; observedAt: string; firstObservation: boolean;
  timezone?: string; currentObserved?: boolean;
}): CreativeChangeCertainty {
  const to = new Date(input.observedAt).toISOString();
  if (input.firstObservation) return { kind: 'first', from: null, to, widthDays: null };
  if (input.previous === null) return { kind: 'window', from: null, to, widthDays: null };
  const from = new Date(input.previous).toISOString();
  if (from > to) throw new Error('Previous observation follows current observation');
  const calendar = new Intl.DateTimeFormat('en-CA', { timeZone: input.timezone ?? 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' });
  const day = (at: string) => {
    const parts = calendar.formatToParts(new Date(at));
    const value = (kind: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === kind)!.value;
    return Date.parse(`${value('year')}-${value('month')}-${value('day')}T00:00:00Z`);
  };
  const widthDays = Math.round((day(to) - day(from)) / 86400000);
  return { kind: input.currentObserved !== false && widthDays <= 1 ? 'exact' : 'window', from, to, widthDays };
}
