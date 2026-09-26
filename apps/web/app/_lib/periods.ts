/**
 * Periods, and the comparison period every grid gets for free.
 *
 * The recon's best small idea (`https://github.com/Ecom-Wizards-Agency/Arcana/blob/dd4f3887f626128250abee537f374712ca42717c/tools/recon/02-data-grid.md` §2): the comparison period
 * defaults to *the immediately preceding period of the same length*, so every
 * grid can show a delta without the operator choosing a baseline. Copied
 * exactly, including the "same length" part -- comparing a 30-day window
 * against a calendar month would produce deltas nobody could reason about.
 *
 * Dates are `YYYY-MM-DD` strings in the profile's own calendar, arithmetic is
 * done in UTC. A `Date` here would invite a timezone to shift a profile's day
 * boundary, which is exactly the bug the fact tables were designed to avoid by
 * storing `date` rather than a timestamp.
 */
export interface Period {
  start: string;
  end: string;
}

export const DEFAULT_WINDOW_DAYS = 30;
/** Amazon can restate attributed sales for this many trailing days. */
export const ATTRIBUTION_SETTLING_DAYS = 14;

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d) + days * 86_400_000).toISOString().slice(0, 10);
}

export function daysBetween(start: string, end: string): number {
  const toMs = (date: string): number => {
    const [y, m, d] = date.split('-').map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toMs(end) - toMs(start)) / 86_400_000) + 1;
}

/** The window ending yesterday: today is provisional and would read as a collapse. */
export function defaultPeriod(today: string, windowDays = DEFAULT_WINDOW_DAYS): Period {
  const end = addDays(today, -1);
  return { start: addDays(end, -(windowDays - 1)), end };
}

/** A rolling window that deliberately includes the profile's current day. */
export function periodThroughToday(today: string, windowDays = DEFAULT_WINDOW_DAYS): Period {
  return { start: addDays(today, -(windowDays - 1)), end: today };
}

/** The same number of days, immediately before. */
export function precedingPeriod(period: Period): Period {
  const length = daysBetween(period.start, period.end);
  const end = addDays(period.start, -1);
  return { start: addDays(end, -(length - 1)), end };
}

export interface SettledComparisonWindows {
  /** Selected-period dates old enough for their attributed sales to be stable. */
  current: Period | null;
  /** Equal-length period immediately before `current`. */
  comparison: Period | null;
  /** The trailing dates whose attributed sales may still restate. */
  settling: Period;
}

/**
 * Split a selected range into settled KPI evidence and the visible settling tail.
 *
 * The chart still shows the selected period. KPI values and deltas use `current`
 * and `comparison`, which are equal-length and never include one of Amazon's
 * trailing 14 restatement days.
 */
export function settledComparisonWindows(period: Period, today: string): SettledComparisonWindows {
  const settling: Period = {
    start: addDays(today, -ATTRIBUTION_SETTLING_DAYS),
    end: addDays(today, -1),
  };
  const settledEnd = period.end < settling.start ? period.end : addDays(settling.start, -1);
  if (settledEnd < period.start) return { current: null, comparison: null, settling };
  const current = { start: period.start, end: settledEnd };
  return { current, comparison: precedingPeriod(current), settling };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Read a period off the query string, falling back to the default window.
 *
 * An unparseable or inverted range falls back rather than erroring: a deep link
 * somebody hand-edited should show the default month, not a stack trace.
 */
export function periodFromParams(
  params: { from?: string; to?: string },
  today: string,
  windowDays = DEFAULT_WINDOW_DAYS,
): Period {
  const { from, to } = params;
  if (from === undefined || to === undefined) return defaultPeriod(today, windowDays);
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to) || from > to) return defaultPeriod(today, windowDays);
  return { start: from, end: to };
}

/**
 * Read a period for evidence that is observed on the profile's current day.
 *
 * Creative mappings are a current Amazon snapshot, so excluding today can
 * hide the only defensible mapping/fact pair immediately after a sync. Other
 * analytical routes keep using `periodFromParams` and complete days only.
 */
export function periodFromParamsThroughToday(
  params: { from?: string; to?: string },
  today: string,
  windowDays = DEFAULT_WINDOW_DAYS,
): Period {
  const { from, to } = params;
  if (from === undefined || to === undefined) return periodThroughToday(today, windowDays);
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to) || from > to) {
    return periodThroughToday(today, windowDays);
  }
  return { start: from, end: to };
}

export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Return the calendar day at `now` in an IANA timezone as YYYY-MM-DD. */
export function todayIsoInTimeZone(timezone: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: '2-digit',
    timeZone: timezone,
    year: 'numeric',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/**
 * The one default-date rule every screen follows.
 *
 * A screen opened without a valid `from`/`to` shows the last
 * DEFAULT_WINDOW_DAYS complete days: through yesterday, on the server's UTC
 * calendar. A screen may differ only by being listed in SCREEN_DATE_EXCEPTIONS
 * with its reason. A valid explicit `from`/`to` is always kept as given.
 */
export interface ScreenDateRule {
  windowDays: number;
  /** Include the current day, or stop at yesterday. */
  throughToday: boolean;
  /** Whose calendar decides "today": the server's UTC date or the profile's timezone. */
  calendar: 'utc' | 'profile';
  /** Why a screen departs from the standard rule; null for the standard rule itself. */
  reason: string | null;
}

/** Registered screens whose load reads a date window; a test pins this list to the registry and the loads. */
export const DATE_WINDOW_SCREEN_IDS = [
  'brand-lens', 'cockpit', 'creative', 'dayparting', 'grid', 'market-position', 'ngrams',
  'optimizer', 'optimizer-group', 'query-intelligence', 'targets', 'timeline',
] as const;
export type DateWindowScreenId = (typeof DATE_WINDOW_SCREEN_IDS)[number];

export const STANDARD_SCREEN_DATE_RULE: ScreenDateRule = {
  windowDays: DEFAULT_WINDOW_DAYS,
  throughToday: false,
  calendar: 'utc',
  reason: null,
};

/** Screens with a documented reason to open on a different window, keyed by screen id. */
export const SCREEN_DATE_EXCEPTIONS = {
  creative: {
    windowDays: DEFAULT_WINDOW_DAYS,
    throughToday: true,
    calendar: 'profile',
    reason: 'Creative mappings are a current Amazon snapshot, so excluding the profile\'s current day can hide the only defensible mapping and fact pair right after a sync.',
  },
  dayparting: {
    windowDays: 56,
    throughToday: true,
    calendar: 'utc',
    reason: 'Dayparting reads hourly facts in UTC hours; 56 days is eight of every weekday, so each weekday-hour cell covers the same number of days, and hours already reported today are included.',
  },
} as const satisfies Partial<Readonly<Record<DateWindowScreenId, ScreenDateRule>>>;

/** The rule for a screen id: its documented exception, or the standard rule. */
export function screenDateRule(screenId: DateWindowScreenId): ScreenDateRule {
  return (SCREEN_DATE_EXCEPTIONS as Partial<Readonly<Record<DateWindowScreenId, ScreenDateRule>>>)[screenId] ?? STANDARD_SCREEN_DATE_RULE;
}

/** "Today" on the calendar the screen's rule names. */
export function screenToday(screenId: DateWindowScreenId, profileTimezone: string | null, now: Date = new Date()): string {
  return screenDateRule(screenId).calendar === 'profile' && profileTimezone !== null
    ? todayIsoInTimeZone(profileTimezone, now)
    : todayIso(now);
}

/**
 * The period a screen shows: a valid explicit `from`/`to` unchanged, otherwise
 * the screen's default window from `screenDateRule`.
 */
export function screenPeriod(
  screenId: DateWindowScreenId,
  params: { from?: string | undefined; to?: string | undefined },
  today: string,
): Period {
  return periodForRule(screenDateRule(screenId), params, today);
}

/** The period a date rule shows: a valid explicit `from`/`to` unchanged, otherwise the rule's default window. */
export function periodForRule(
  rule: ScreenDateRule,
  params: { from?: string | undefined; to?: string | undefined },
  today: string,
): Period {
  const input = {
    ...(params.from === undefined ? {} : { from: params.from }),
    ...(params.to === undefined ? {} : { to: params.to }),
  };
  return rule.throughToday
    ? periodFromParamsThroughToday(input, today, rule.windowDays)
    : periodFromParams(input, today, rule.windowDays);
}

/**
 * Dayparting's repair of a partial range: a missing or invalid end keeps the
 * default for that end alone; an inverted pair falls back whole.
 */
export function keepValidEnds(
  fallback: Period,
  params: { from?: string | undefined; to?: string | undefined },
): Period {
  const start = params.from !== undefined && ISO_DATE.test(params.from) ? params.from : fallback.start;
  const end = params.to !== undefined && ISO_DATE.test(params.to) ? params.to : fallback.end;
  return start <= end ? { start, end } : fallback;
}
