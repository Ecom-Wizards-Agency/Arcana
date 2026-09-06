/**
 * Tag colours, as the product paints them.
 *
 * `TagColor` in `@wizard-ads/shared` names a brand token; this is where the
 * name becomes a `var(--wa-*)` reference. Keeping the mapping here and the
 * vocabulary in the contract means a screen cannot invent a sixth swatch, and
 * a brand token can move without a migration.
 */
import { TagColor } from '@wizard-ads/shared';

/**
 * The swatch a tag with no usable colour paints.
 *
 * "No usable colour" is a `null` column and, just as often, one of the
 * arbitrary strings the free colour input wrote before the contract existed.
 * Both are the same question — what should this dot be? — and neither is an
 * error, so both answer with the neutral series grey the tree already used.
 */
export const NEUTRAL_SWATCH = 'var(--wa-series-3)';

const SWATCH_TOKEN: Record<TagColor, string> = {
  signal: 'var(--wa-signal)',
  indigo: 'var(--wa-indigo)',
  good: 'var(--wa-good)',
  warn: 'var(--wa-warn)',
  bad: 'var(--wa-bad)',
};

const SWATCH_LABEL: Record<TagColor, string> = {
  signal: 'Signal orange',
  indigo: 'Electric indigo',
  good: 'Green',
  warn: 'Amber',
  bad: 'Red',
};

/** The colour a stored value paints. Never throws: an unreadable value is neutral. */
export function tagSwatchColor(stored: string | null): string {
  const parsed = TagColor.safeParse(stored);
  return parsed.success ? SWATCH_TOKEN[parsed.data] : NEUTRAL_SWATCH;
}

/** The accessible name of a swatch control. */
export function tagSwatchLabel(color: TagColor): string {
  return SWATCH_LABEL[color];
}
