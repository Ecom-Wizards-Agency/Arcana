import { CreatorSampleOrderKey } from '@wizard-ads/shared';

/** The derived order key from the path, or null when the path does not carry one (`CCS-` and 32 hex). */
export function sampleOrderKeyParam(value: string | undefined): string | null {
  const parsed = CreatorSampleOrderKey.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** hh:mm:ss in UTC, as the sample screens print a read time. */
export const clock = (value: string) => new Date(value).toISOString().slice(11, 19);
/** Provenance per value: which Amazon operation said it, and when. */
export const amazonRead = (operation: string, readAt: string) => `Amazon · ${operation} · ${clock(readAt)}`;
/** Cents as the runner recorded them, in the marketplace currency when one was read. Null is not recorded, never 0.00. */
export function money(cents: number | null, currency: string | null = null): string {
  if (cents === null) return 'not recorded';
  return `${(cents / 100).toFixed(2)}${currency === null ? '' : ` ${currency}`}`;
}
