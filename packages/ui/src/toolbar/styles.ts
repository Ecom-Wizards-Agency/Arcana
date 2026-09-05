/**
 * Inline style objects for the grid toolbar and its four controls.
 *
 * Kept as `CSSProperties` literals rather than a stylesheet for the same reason
 * as the grid: the toolbar is drop-in, and the export button's accent gradient
 * is asserted from its `style` attribute by the tests.
 */
import type { CSSProperties } from 'react';
import { tokens } from '../theme.js';

export const bar: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  fontFamily: tokens.font.sans,
  fontSize: tokens.font.size.sm,
  gap: tokens.space(2),
  marginBottom: tokens.space(3),
};

export const row: CSSProperties = {
  alignItems: 'center',
  display: 'flex',
  flexWrap: 'wrap',
  gap: tokens.space(2),
};

export const controlsRow: CSSProperties = {
  ...row,
  justifyContent: 'flex-end',
};

export const spacer: CSSProperties = { flex: 1 };

export const control: CSSProperties = {
  background: tokens.color.surface,
  border: `1px solid ${tokens.color.borderStrong}`,
  borderRadius: tokens.radius.sm,
  color: tokens.color.text,
  fontSize: tokens.font.size.sm,
  padding: `${tokens.space(1)} ${tokens.space(1.5)}`,
};

export function controlWidth(width: string): CSSProperties {
  return { ...control, width };
}

export const button: CSSProperties = { ...control, background: 'transparent', cursor: 'pointer' };

export const primaryButton: CSSProperties = {
  ...button,
  background: tokens.color.accentGradient,
  borderColor: tokens.color.accent,
  color: tokens.color.onAccent,
  fontWeight: 650,
};

export const linkButton: CSSProperties = {
  background: 'none',
  border: 'none',
  color: tokens.color.accent,
  cursor: 'pointer',
  fontSize: tokens.font.size.sm,
  padding: 0,
};

export const valuePickerWrap: CSSProperties = {
  position: 'relative',
};

export const valueTrigger: CSSProperties = {
  ...control,
  alignItems: 'center',
  cursor: 'pointer',
  display: 'inline-flex',
  gap: tokens.space(2),
  justifyContent: 'space-between',
  minWidth: '11rem',
};

export const valuePicker: CSSProperties = {
  background: tokens.color.surface,
  border: `1px solid ${tokens.color.borderStrong}`,
  borderRadius: tokens.radius.md,
  boxShadow: '0 16px 40px rgb(17 21 28 / 16%)',
  display: 'grid',
  gap: tokens.space(2),
  left: 0,
  minWidth: '18rem',
  padding: tokens.space(2),
  position: 'absolute',
  top: `calc(100% + ${tokens.space(1)})`,
  zIndex: 20,
};

export const valueSearch: CSSProperties = { ...control, width: '100%', boxSizing: 'border-box' };

export const valuePickerActions: CSSProperties = {
  alignItems: 'center',
  display: 'flex',
  gap: tokens.space(2),
};

export const optionCount: CSSProperties = {
  color: tokens.color.textMuted,
  fontSize: tokens.font.size.xs,
  marginLeft: 'auto',
};

export const optionList: CSSProperties = {
  display: 'grid',
  gap: tokens.space(0.5),
  maxHeight: '15rem',
  overflowY: 'auto',
};

export const optionItem: CSSProperties = {
  alignItems: 'center',
  borderRadius: tokens.radius.sm,
  cursor: 'pointer',
  display: 'flex',
  gap: tokens.space(2),
  minHeight: '2rem',
  padding: `0 ${tokens.space(1)}`,
};

export const optionEmpty: CSSProperties = {
  color: tokens.color.textMuted,
  margin: tokens.space(2),
};

export const optionHint: CSSProperties = {
  color: tokens.color.textMuted,
  fontSize: tokens.font.size.xs,
  margin: 0,
};

export const groupingControl: CSSProperties = {
  alignItems: 'center',
  display: 'flex',
  flexWrap: 'wrap',
  gap: tokens.space(1),
};

export const groupingLabel: CSSProperties = {
  color: tokens.color.textMuted,
  fontSize: tokens.font.size.xs,
  fontWeight: 600,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
};

export const groupingList: CSSProperties = {
  alignItems: 'center',
  display: 'flex',
  flexWrap: 'wrap',
  gap: tokens.space(1),
  listStyle: 'none',
  margin: 0,
  padding: 0,
};

export const groupingLevel: CSSProperties = {
  alignItems: 'center',
  background: tokens.color.surfaceAlt,
  border: `1px solid ${tokens.color.borderStrong}`,
  borderRadius: tokens.radius.sm,
  display: 'inline-flex',
  gap: tokens.space(0.5),
  padding: `${tokens.space(0.5)} ${tokens.space(1)}`,
};

export const levelNumber: CSSProperties = {
  color: tokens.color.textMuted,
  fontVariantNumeric: 'tabular-nums',
  fontWeight: 600,
};

const levelButton: CSSProperties = {
  background: 'none',
  border: 'none',
  color: tokens.color.textMuted,
  cursor: 'pointer',
  lineHeight: 1,
  padding: tokens.space(0.5),
};

const levelButtonDisabled: CSSProperties = {
  cursor: 'default',
  opacity: 0.35,
};

export function levelButtonStyle(disabled: boolean): CSSProperties {
  return disabled ? { ...levelButton, ...levelButtonDisabled } : levelButton;
}

export const segmented: CSSProperties = {
  border: `1px solid ${tokens.color.borderStrong}`,
  borderRadius: tokens.radius.md,
  display: 'flex',
  overflow: 'hidden',
};

const segment: CSSProperties = {
  background: tokens.color.surface,
  border: 'none',
  color: tokens.color.text,
  cursor: 'pointer',
  fontSize: tokens.font.size.sm,
  padding: `${tokens.space(1)} ${tokens.space(3)}`,
};

const segmentActive: CSSProperties = {
  background: tokens.color.indigoSoft,
  color: tokens.color.text,
  fontWeight: 600,
};

export function segmentStyle(active: boolean): CSSProperties {
  return active ? { ...segment, ...segmentActive } : segment;
}

export const chip: CSSProperties = {
  alignItems: 'center',
  background: tokens.color.indigoSoft,
  border: `1px solid ${tokens.color.indigo}`,
  borderRadius: tokens.radius.pill,
  color: tokens.color.text,
  display: 'inline-flex',
  fontSize: tokens.font.size.xs,
  gap: tokens.space(1),
  padding: `${tokens.space(0.5)} ${tokens.space(2)}`,
};

export const chipClose: CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'inherit',
  cursor: 'pointer',
  fontSize: tokens.font.size.base,
  lineHeight: 1,
  padding: 0,
};

export const picker: CSSProperties = {
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.md,
  display: 'grid',
  gap: tokens.space(1),
  gridTemplateColumns: 'repeat(auto-fill, minmax(12rem, 1fr))',
  maxHeight: '16rem',
  overflow: 'auto',
  padding: tokens.space(3),
};

export const pickerItem: CSSProperties = {
  alignItems: 'center',
  display: 'flex',
  fontSize: tokens.font.size.xs,
  gap: tokens.space(1),
};
