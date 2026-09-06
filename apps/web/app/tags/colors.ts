/**
 * Tag colours, as the product paints them.
 *
 * `TagColor` in `@wizard-ads/shared` names a brand token; this is where the
 * name becomes a `var(--wa-*)` reference. Keeping the mapping here and the
 * vocabulary in the contract means a screen cannot invent a sixth swatch, and
 * a brand token can move without a migration.
 */
import type { CSSProperties } from 'react';
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

/**
 * The inline style of one swatch control.
 *
 * A swatch is a fixed brand colour, so *selected* cannot be carried by the fill
 * without inventing a sixth hue. It is carried by a ring drawn **inside** the
 * swatch, and the outline is deliberately absent from this object at any value.
 *
 * An inline `outline` beats the `:focus-visible` rule in `theme.css`, and the
 * light theme — the shipped default — sets `--wa-focus-contrast: transparent`,
 * so the outline is the entire focus affordance. Writing `outline: 'none'` on a
 * control with no text leaves a keyboard user with nothing to see. Selection is
 * therefore inside the swatch, focus is the ring outside it, and the two read
 * as different states rather than one.
 */
export function tagSwatchStyle(background: string, selected: boolean): CSSProperties {
  return {
    background,
    border: '1px solid var(--wa-border-strong)',
    borderRadius: 'var(--wa-radius-pill)',
    cursor: 'pointer',
    height: 22,
    padding: 0,
    width: 22,
    ...(selected
      ? { boxShadow: 'inset 0 0 0 2px var(--wa-surface), inset 0 0 0 4px var(--wa-text)' }
      : {}),
  };
}
