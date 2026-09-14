import { tokenValues, type TokenName } from './tokens.generated.js';

/** Standalone light fallbacks are generated from the shared CSS source. */
export const token = (name: TokenName): string => `var(${name}, ${tokenValues.light[name]})`;

export const tokens = {
  font: {
    sans: token('--wa-font'),
    mono: token('--wa-font-mono'),
    size: { eyebrow: token('--wa-fs-2xs'), xs: token('--wa-fs-xs'), sm: token('--wa-fs-sm'), base: token('--wa-fs-base'), lg: token('--wa-fs-md'), xl: token('--wa-fs-xl'), kpi: token('--wa-fs-2xl') },
  },
  color: {
    text: token('--wa-text'),
    textMuted: token('--wa-text-muted'),
    textFaint: token('--wa-text-faint'),
    border: token('--wa-border'),
    borderStrong: token('--wa-border-strong'),
    surface: token('--wa-surface'),
    surfaceAlt: token('--wa-surface-2'),
    surfaceHover: token('--wa-surface-3'),
    accent: token('--wa-accent'),
    accentGradient: token('--wa-accent-grad'),
    accentSoft: token('--wa-accent-soft'),
    indigo: token('--wa-indigo'),
    indigoSoft: token('--wa-indigo-soft'),
    onAccent: token('--wa-on-accent'),
    good: token('--wa-good-text'),
    goodSoft: token('--wa-good-bg'),
    goodBorder: token('--wa-good-border'),
    warn: token('--wa-warn-text'),
    warnSoft: token('--wa-warn-bg'),
    warnBorder: token('--wa-warn-border'),
    bad: token('--wa-bad-text'),
    badSoft: token('--wa-bad-bg'),
    badBorder: token('--wa-bad-border'),
  },
  radius: { sm: token('--wa-radius-sm'), md: token('--wa-radius'), pill: token('--wa-radius-pill') },
  space: (n: number) => `${n * 0.25}rem`,
} as const;

export type Tone = 'good' | 'warn' | 'bad' | 'muted' | 'neutral';

export const toneStyle: Record<Tone, { background: string; border: string; color: string }> = {
  good: { background: tokens.color.goodSoft, border: tokens.color.goodBorder, color: tokens.color.good },
  warn: { background: tokens.color.warnSoft, border: tokens.color.warnBorder, color: tokens.color.warn },
  bad: { background: tokens.color.badSoft, border: tokens.color.badBorder, color: tokens.color.bad },
  muted: { background: tokens.color.surfaceAlt, border: tokens.color.border, color: tokens.color.textMuted },
  neutral: { background: tokens.color.indigoSoft, border: token('--wa-info-border'), color: tokens.color.indigo },
};

/**
 * Delta colouring, driven by the metric's `better` direction rather than the
 * sign. ACOS down is green; spend down is neither, so it stays neutral. Sign
 * alone would paint a 40% spend cut as a triumph on a rank push.
 */
export function deltaColor(value: number | null, better: 'higher' | 'lower' | null): string {
  if (value === null || value === 0 || better === null) return tokens.color.textMuted;
  const good = better === 'higher' ? value > 0 : value < 0;
  return good ? tokens.color.good : tokens.color.bad;
}
