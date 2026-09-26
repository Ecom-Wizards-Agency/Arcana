/**
 * Inline style objects for the data grid and the helpers that compose them.
 *
 * Everything is a `CSSProperties` literal rather than a stylesheet for the
 * reason `theme.ts` gives: the components are drop-in and cannot collide with
 * a host stylesheet, and the selection/accent colours are asserted from the
 * `style` attribute by the tests. Nothing in here decides *what* to render;
 * the helpers only fold a column's width, alignment and pinning into a style.
 */
import type { CSSProperties } from 'react';
import { isSelectionColumn, minimumColumnWidth, type GridColumn } from '../columns.js';
import type { GridDensity } from '../density.js';
import { tokens } from '../theme.js';

/**
 * The header's height is fixed rather than derived from its padding, because
 * the totals row sticks directly beneath it and `top` has to be exactly the
 * header's height. Deriving one from the other in CSS is not possible, and
 * guessing it puts the totals row over the first data row -- which is what
 * happened before this was pinned.
 */
export const HEADER_HEIGHT = 44;

/**
 * The grid's rules and header band (V15). The page border token alone is a
 * 1.2:1 line on the zebra rows, which is why rows and columns ran together;
 * body rules sit halfway to the strong border, header rules use it outright,
 * and the header is a band of its own (`surfaceHover`) rather than the same
 * white as every other row. Tokens only, so dark mode follows.
 */
export const GRID_RULE = `color-mix(in srgb, ${tokens.color.borderStrong} 50%, ${tokens.color.border})`;
export const GRID_HEADER_RULE = tokens.color.borderStrong;
export const GRID_HEADER_BACKGROUND = tokens.color.surfaceHover;

export const shell: CSSProperties = {
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.md,
  display: 'flex',
  flexDirection: 'column',
  fontFamily: tokens.font.sans,
  fontSize: tokens.font.size.base,
  overflow: 'hidden',
};

/**
 * With no height given the shell fills whatever flex column the host puts it
 * in (`GridViewport` is the one shipped here). `minHeight: 0` is what lets a
 * flex child shrink below its content so the scroller, not the page, scrolls.
 */
export const shellFill: CSSProperties = {
  ...shell,
  flex: '1 1 auto',
  minHeight: 0,
};

export const scroller: CSSProperties = { overflow: 'auto', position: 'relative' };

export const scrollerFill: CSSProperties = {
  ...scroller,
  flex: '1 1 auto',
  minHeight: 0,
};

export const headerRow: CSSProperties = {
  background: GRID_HEADER_BACKGROUND,
  borderBottom: `1px solid ${GRID_HEADER_RULE}`,
  color: tokens.color.text,
  boxSizing: 'border-box',
  display: 'flex',
  height: HEADER_HEIGHT,
  position: 'sticky',
  top: 0,
  zIndex: 4,
};

const headerCell: CSSProperties = {
  alignItems: 'center',
  borderRight: `1px solid ${GRID_HEADER_RULE}`,
  boxSizing: 'border-box',
  color: tokens.color.text,
  cursor: 'pointer',
  display: 'flex',
  fontSize: tokens.font.size.eyebrow,
  fontWeight: 600,
  gap: tokens.space(1),
  padding: `${tokens.space(1.5)} ${tokens.space(2)}`,
  position: 'relative',
  userSelect: 'none',
  whiteSpace: 'nowrap',
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
};

/**
 * `minWidth: 0` and `maxWidth: 100%` let the label shrink inside its flex
 * column; without them a right-aligned header wider than its column is clipped
 * from the left ("MPRESSIONS") instead of ending in an ellipsis.
 */
export const headerLabel: CSSProperties = {
  maxWidth: '100%',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

const headerStack: CSSProperties = {
  display: 'flex',
  flex: '1 1 auto',
  flexDirection: 'column',
  lineHeight: 1.1,
  minWidth: 0,
  overflow: 'hidden',
};

export const headerAggregate: CSSProperties = {
  color: tokens.color.textMuted,
  fontSize: tokens.font.size.xs,
  fontWeight: 500,
  marginTop: '0.125rem',
};

export const sortMark: CSSProperties = { color: tokens.color.accent, fontSize: '0.625rem' };

/** The hover affordance on an unsorted header: same slot as the sort mark, muted. */
export const sortHint: CSSProperties = { color: tokens.color.textFaint, fontSize: '0.625rem' };

const pinButton: CSSProperties = {
  background: 'none',
  border: 'none',
  color: tokens.color.textMuted,
  cursor: 'pointer',
  fontSize: '0.625rem',
  padding: 0,
};

/**
 * The column edge. A grip the operator can see at rest (a short rule in the
 * header's rule colour) that turns accent and full height while it is hovered,
 * focused or dragged; the hit area is wider than the grip.
 */
export function resizeHandleStyle(active: boolean): CSSProperties {
  const colour = active ? tokens.color.accent : GRID_HEADER_RULE;
  return {
    background: `linear-gradient(${colour}, ${colour}) right 2px center / ${active ? '3px 100%' : '2px 55%'} no-repeat`,
    cursor: 'col-resize',
    height: '100%',
    position: 'absolute',
    right: 0,
    top: 0,
    touchAction: 'none',
    width: '9px',
    zIndex: 1,
  };
}

export const bodyRow: CSSProperties = {
  borderBottom: `1px solid ${GRID_RULE}`,
  display: 'flex',
};

export const totalsRow: CSSProperties = {
  ...bodyRow,
  background: tokens.color.accentSoft,
  borderBottom: `1px solid ${tokens.color.borderStrong}`,
  position: 'sticky',
  top: HEADER_HEIGHT,
  zIndex: 3,
};

const bodyCell: CSSProperties = {
  borderRight: `1px solid ${GRID_RULE}`,
  boxSizing: 'border-box',
  fontVariantNumeric: 'tabular-nums',
  fontSize: tokens.font.size.sm,
  overflow: 'hidden',
  padding: `${tokens.space(1)} ${tokens.space(2)}`,
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

/** Cell padding per density; the row height itself comes from `density.ts`. */
const CELL_PADDING: Record<GridDensity, string> = {
  compact: `${tokens.space(0.5)} ${tokens.space(1.5)}`,
  normal: `${tokens.space(1)} ${tokens.space(2)}`,
  comfortable: `${tokens.space(1.5)} ${tokens.space(2.5)}`,
};

export const twoLineCell: CSSProperties = {
  display: 'inline-flex',
  flexDirection: 'column',
  lineHeight: 1.05,
};

export const cellSubline: CSSProperties = {
  color: tokens.color.textMuted,
  fontSize: tokens.font.size.xs,
  marginTop: '0.125rem',
};

export const groupCell: CSSProperties = {
  alignItems: 'center',
  display: 'inline-flex',
  gap: tokens.space(1),
  maxWidth: '100%',
};

export const groupBranch: CSSProperties = {
  color: tokens.color.textMuted,
  flex: '0 0 auto',
};

export const groupToggle: CSSProperties = {
  alignItems: 'center',
  background: 'none',
  border: 'none',
  color: tokens.color.textMuted,
  cursor: 'pointer',
  display: 'inline-flex',
  flex: '0 0 auto',
  justifyContent: 'center',
  padding: tokens.space(0.5),
};

export const groupLeafMarker: CSSProperties = {
  color: tokens.color.textMuted,
  flex: '0 0 auto',
  textAlign: 'center',
  width: tokens.space(2),
};

export const groupValue: CSSProperties = {
  fontWeight: 600,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
};

export const groupCount: CSSProperties = {
  color: tokens.color.textMuted,
  flex: '0 0 auto',
  fontSize: tokens.font.size.xs,
};

export const emptyState: CSSProperties = {
  color: tokens.color.textMuted,
  padding: tokens.space(8),
  textAlign: 'center',
};

export const footer: CSSProperties = {
  alignItems: 'center',
  borderTop: `1px solid ${tokens.color.border}`,
  color: tokens.color.text,
  display: 'flex',
  fontSize: tokens.font.size.sm,
  gap: tokens.space(3),
  justifyContent: 'space-between',
  padding: `${tokens.space(1.5)} ${tokens.space(3)}`,
};

export const footerNote: CSSProperties = { color: tokens.color.textMuted };

export const footerSelection: CSSProperties = { color: tokens.color.indigo, fontWeight: 600 };

/**
 * A row-selection column: centred, unpadded and unclipped. The checkbox rendered
 * oddly because an eight-pixel padding either side left twelve of its thirteen
 * pixels in a 28px column (J4).
 */
const selectionCell: CSSProperties = {
  cursor: 'default',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  overflow: 'visible',
  padding: 0,
};

/** A pinned column sticks to the left of the scroller above whatever scrolls under it. */
export interface Pinned {
  left: number;
}

function sticky(pinned: Pinned | null, zIndex: number, background: string): CSSProperties {
  return pinned === null ? {} : { position: 'sticky', left: pinned.left, zIndex, background };
}

export function headerCellStyle(
  width: number,
  definition: GridColumn | undefined,
  pinned: Pinned | null,
): CSSProperties {
  return {
    ...headerCell,
    width,
    flexShrink: 0,
    ...(definition === undefined ? {} : { minWidth: minimumColumnWidth(definition) }),
    justifyContent: definition?.align === 'right' ? 'flex-end' : 'flex-start',
    // A control header does not sort, so it must not offer a sort cursor; a
    // selection header's checkbox sits centred with no padding to clip it.
    ...(definition?.kind === 'control' ? { cursor: 'default' } : {}),
    ...(isSelectionColumn(definition) ? selectionCell : {}),
    ...sticky(pinned, 3, GRID_HEADER_BACKGROUND),
  };
}

export function headerStackStyle(definition: GridColumn | undefined): CSSProperties {
  return {
    ...headerStack,
    alignItems: isSelectionColumn(definition) ? 'center' : definition?.align === 'right' ? 'flex-end' : 'flex-start',
    ...(isSelectionColumn(definition) ? { overflow: 'visible' } : {}),
  };
}

/** Header label; a selection header's checkbox is never clipped by the ellipsis. */
export function headerLabelStyle(definition: GridColumn | undefined): CSSProperties {
  return isSelectionColumn(definition) ? { display: 'inline-flex', overflow: 'visible' } : headerLabel;
}

export function pinButtonStyle(isPinned: boolean): CSSProperties {
  return { ...pinButton, opacity: isPinned ? 1 : 0.25 };
}

export function totalsCellStyle(
  width: number,
  definition: GridColumn | undefined,
  pinned: Pinned | null,
): CSSProperties {
  return {
    ...bodyCell,
    ...(definition?.scale !== 'text' || definition?.cell === 'numeric'
      ? { overflow: 'auto', textOverflow: 'unset' } : {}),
    width,
    flexShrink: 0,
    ...(definition === undefined ? {} : { minWidth: minimumColumnWidth(definition) }),
    textAlign: definition?.align ?? 'left',
    fontWeight: 600,
    ...sticky(pinned, 2, tokens.color.surfaceAlt),
  };
}

export function bodyCellStyle(
  width: number,
  definition: GridColumn | undefined,
  pinned: Pinned | null,
  density: GridDensity = 'normal',
): CSSProperties {
  return {
    ...bodyCell,
    ...(definition?.scale !== 'text' || definition?.cell === 'numeric'
      ? { overflow: 'auto', textOverflow: 'unset' } : {}),
    padding: CELL_PADDING[density],
    width,
    flexShrink: 0,
    ...(definition === undefined ? {} : { minWidth: minimumColumnWidth(definition) }),
    textAlign: definition?.align ?? 'left',
    ...(isSelectionColumn(definition) ? selectionCell : {}),
    ...sticky(pinned, 1, 'inherit'),
  };
}

export interface BodyRowState {
  height: number;
  index: number;
  clickable: boolean;
  selected: boolean;
  /** The row holding keyboard focus, drawn with a ring so the roving tab stop is visible. */
  focused: boolean;
  /** `null` when the row is a source row; otherwise its hierarchy depth and leafness. */
  group: { depth: number; isLeaf: boolean } | null;
}

/**
 * Row background precedence: selection, then a collapsible group header, then
 * zebra striping. A top-level group also draws a stronger rule above it.
 */
export function bodyRowStyle(state: BodyRowState): CSSProperties {
  // Composite the translucent tint onto the surface before pinned cells inherit it.
  // Otherwise numeric cells scrolling underneath remain visible through the pin.
  const tint = state.selected || state.group?.depth === 0 ? tokens.color.indigoSoft
    : state.group !== null || state.index % 2 !== 0 ? tokens.color.surfaceAlt : tokens.color.surface;
  return {
    ...bodyRow,
    height: state.height,
    cursor: state.clickable ? 'pointer' : 'default',
    outline: state.focused ? `2px solid ${tokens.color.indigo}` : 'none',
    outlineOffset: -2,
    background: `linear-gradient(${tint}, ${tint}), ${tokens.color.surface}`,
    ...(state.group?.depth === 0 ? { borderTop: `1px solid ${tokens.color.borderStrong}` } : {}),
  };
}

export function deltaStyle(color: string): CSSProperties {
  return { color };
}
