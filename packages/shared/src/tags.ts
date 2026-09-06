/**
 * The tag colour contract.
 *
 * A tag's colour used to be free text: the API stored whatever string arrived
 * and the manager offered a native colour picker, so any of sixteen million
 * hues could reach the product and none of them belonged to the brand palette.
 * The colour is therefore a closed vocabulary of brand token *names*, not hex.
 *
 * Names rather than literals for two reasons. A stored `#FD4807` freezes the
 * palette at the moment of the write, so a brand change leaves old rows behind;
 * a stored `signal` follows `theme.css`. And a name resolves per theme, so the
 * same tag can paint correctly in light and dark without a second column.
 *
 * Rows written before this contract hold arbitrary strings. They stay readable:
 * the reader treats an unrecognised value as absent and the surface paints its
 * neutral swatch. Only writes are refused.
 */
import { z } from 'zod';

/**
 * The swatch vocabulary, in swatch order.
 *
 * Each value names a fixed brand token in `apps/web/src/ui/theme.css`. The five
 * are the palette's distinguishable hues; grey is deliberately absent, because
 * grey is what an uncoloured tag already paints.
 */
export const TagColor = z.enum(['signal', 'indigo', 'good', 'warn', 'bad']);
export type TagColor = z.infer<typeof TagColor>;

/** The vocabulary as a list, derived from the schema so the two cannot drift. */
export const TAG_COLORS = TagColor.options;

/**
 * The colour as it crosses the tag API boundary.
 *
 * `null` is a legal colour: a tag without one is the common case and paints the
 * neutral swatch. Anything else must be a member of the vocabulary.
 */
export const TagColorInput = TagColor.nullable();
export type TagColorInput = z.infer<typeof TagColorInput>;
