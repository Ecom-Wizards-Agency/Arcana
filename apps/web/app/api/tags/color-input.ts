/**
 * The colour field, parsed at the HTTP boundary.
 *
 * Both tag routes used to accept `typeof body.color === 'string'` and hand the
 * result straight to the insert, which is how an off-palette hex reached the
 * column. `unknown` in, `TagColorInput` out, one place, so create and update
 * cannot disagree about what a colour is.
 */
import { TagColorInput, TAG_COLORS } from '@wizard-ads/shared';
import type { TagColorInput as TagColorField } from '@wizard-ads/shared';

/**
 * `errorResponse` answers 400 for a plain Error, which is the right status for
 * a caller who sent a colour outside the vocabulary. The message names the
 * vocabulary rather than saying "invalid", because the operator's next move is
 * to pick one of these five.
 */
function refuse(): never {
  throw new Error(`color must be null or one of ${TAG_COLORS.join(', ')}`);
}

/** Parse a required colour field, where absent means "no colour". */
export function parseTagColor(value: unknown): TagColorField {
  if (value === undefined) return null;
  const parsed = TagColorInput.safeParse(value);
  return parsed.success ? parsed.data : refuse();
}

/**
 * Parse an optional colour field for a partial update.
 *
 * Absent means "leave the stored colour alone" — including a legacy value the
 * contract would refuse — so an operator can rename a pre-contract tag without
 * being forced to recolour it. Present must be in the vocabulary.
 */
export function parseTagColorPatch(value: unknown): { color: TagColorField } | Record<string, never> {
  if (value === undefined) return {};
  return { color: parseTagColor(value) };
}
