import { rangeDays, rangePresets } from '@wizard-ads/ui';
import { type Period } from '../../app/_lib/periods';

export type DateRangePresetId =
  | 'last_7'
  | 'last_14'
  | 'last_30'
  | 'last_60'
  | 'last_90'
  | 'month_to_date'
  | 'previous_month';

export interface DateRangePreset {
  id: DateRangePresetId;
  label: string;
  period: Period;
}

/** Presets end on the last complete day unless the surface observes current-day evidence. */
export function dateRangePresets(today: string, includeToday = false): DateRangePreset[] {
  return rangePresets(today, includeToday).map(({ id, label, range }) => ({ id: id as DateRangePresetId, label, period: range }));
}

export function selectedDateRangeLabel(
  period: Period,
  today: string,
  includeToday = false,
  selectedPresetId?: string,
): string {
  const presets = dateRangePresets(today, includeToday);
  const matches = (candidate: DateRangePreset): boolean =>
    candidate.period.start === period.start && candidate.period.end === period.end;
  const preset = presets.find(
    (candidate) => candidate.id === selectedPresetId && matches(candidate),
  ) ?? presets.find(
    (candidate) => candidate.period.start === period.start && candidate.period.end === period.end,
  );
  return preset?.label ?? `${shortDate(period.start)} – ${shortDate(period.end)}`;
}

export function dateRangeHref(
  path: string,
  period: Period,
  preserved: Readonly<Record<string, string | undefined>>,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(preserved)) {
    if (value !== undefined && key !== 'from' && key !== 'to') params.set(key, value);
  }
  params.set('from', period.start);
  params.set('to', period.end);
  return `${path}?${params.toString()}`;
}

function shortDate(value: string): string {
  const [year, month, day] = value.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) return value;
  return new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
    year: 'numeric',
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

/** Inclusive windows; callers can provide a comparison independent of presets. */
export function comparisonLengthState(period: Period, comparison: Period): {
  currentDays: number; comparisonDays: number; mismatch: boolean;
} {
  const currentDays = rangeDays(period);
  const comparisonDays = rangeDays(comparison);
  return { currentDays, comparisonDays, mismatch: currentDays !== comparisonDays };
}
