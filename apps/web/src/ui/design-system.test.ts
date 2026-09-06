import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./theme.css', import.meta.url), 'utf8');

const BRAND_TOKENS = {
  '--wa-obsidian': '#0F1318',
  '--wa-carbon': '#171C24',
  '--wa-raised': '#1C232D',
  '--wa-slate': '#2A323D',
  '--wa-cloud': '#F5F6F8',
  '--wa-mistline': '#E4E7EC',
  '--wa-mist': '#9AA5B4',
  '--wa-steel': '#5B6573',
  '--wa-ink': '#11151C',
  '--wa-signal': '#FD4807',
  '--wa-indigo': '#3322E0',
  '--wa-good': '#22C55E',
  '--wa-warn': '#F59E0B',
  '--wa-bad': '#EF4444',
  '--wa-series-3': '#868A96',
} as const;

function luminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/../g)
    ?.map((part) => Number.parseInt(part, 16) / 255)
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  if (channels === undefined) throw new Error(`Invalid color ${hex}`);
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}

/** `color-mix(in srgb, a <percent>%, b)`, so an assertion can read a mixed token. */
function mix(a: string, b: string, percent: number): string {
  const parse = (hex: string): number[] => {
    const parts = hex.slice(1).match(/../g);
    if (parts === null) throw new Error(`Invalid color ${hex}`);
    return parts.map((part) => Number.parseInt(part, 16));
  };
  const [left, right] = [parse(a), parse(b)];
  const channels = left.map((value, index) => Math.round(value * (percent / 100) + (right[index] ?? 0) * (1 - percent / 100)));
  return `#${channels.map((value) => value.toString(16).padStart(2, '0').toUpperCase()).join('')}`;
}

function contrast(a: string, b: string): number {
  const high = Math.max(luminance(a), luminance(b));
  const low = Math.min(luminance(a), luminance(b));
  return (high + 0.05) / (low + 0.05);
}

describe('WP-47B brand contract', () => {
  it('declares every fixed brand token exactly once', () => {
    for (const [token, value] of Object.entries(BRAND_TOKENS)) {
      expect(css.match(new RegExp(`${token}: ${value}`, 'g'))).toHaveLength(1);
    }
  });

  it('keeps primary and secondary text AA in both themes', () => {
    expect(contrast(BRAND_TOKENS['--wa-ink'], '#FFFFFF')).toBeGreaterThanOrEqual(4.5);
    expect(contrast(BRAND_TOKENS['--wa-steel'], BRAND_TOKENS['--wa-cloud'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(BRAND_TOKENS['--wa-cloud'], BRAND_TOKENS['--wa-obsidian'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(BRAND_TOKENS['--wa-mist'], BRAND_TOKENS['--wa-carbon'])).toBeGreaterThanOrEqual(4.5);
  });

  it('draws light hairlines with Mistline rather than a mixed grey', () => {
    expect(css).toContain('--wa-border: var(--wa-mistline)');
    expect(css).not.toContain('--wa-border: color-mix(in srgb, var(--wa-ink) 15%, var(--wa-white))');
  });

  it('gives warn its own hue instead of a second helping of the accent', () => {
    const warnDeclarations = css.match(/--wa-warn-(?:text|bg|border):[^;]+;/g) ?? [];
    expect(warnDeclarations).toHaveLength(9);
    for (const declaration of warnDeclarations) {
      expect(declaration).not.toContain('--wa-accent');
      expect(declaration).toContain('--wa-warn');
    }

    // Every rule whose selector is a warn variant paints from a warn token.
    const warnRules = [...css.matchAll(/([^{}]*--warn[^{}]*)\{([^{}]*)\}/g)];
    expect(warnRules.map((rule) => rule[1]?.trim())).toEqual([
      '.wa-badge--warn',
      '.wa-banner--warn',
      '.wa-freshness--warn',
      '.wa-kpi-mini--warn',
    ]);
    for (const [, , body] of warnRules) {
      expect(body).not.toContain('var(--wa-accent');
      expect(body).toContain('var(--wa-warn-');
    }
  });

  it('keeps warn text AA in both themes', () => {
    const lightWarnText = mix(BRAND_TOKENS['--wa-warn'], BRAND_TOKENS['--wa-ink'], 55);
    expect(css).toContain('--wa-warn-text: color-mix(in srgb, var(--wa-warn) 55%, var(--wa-ink))');
    expect(contrast(lightWarnText, BRAND_TOKENS['--wa-cloud'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(BRAND_TOKENS['--wa-warn'], BRAND_TOKENS['--wa-carbon'])).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps chart marks at 3:1 in light and dark, outlining dark indigo', () => {
    for (const stroke of [BRAND_TOKENS['--wa-signal'], BRAND_TOKENS['--wa-series-3']]) {
      expect(contrast(stroke, BRAND_TOKENS['--wa-cloud'])).toBeGreaterThanOrEqual(3);
      expect(contrast(stroke, BRAND_TOKENS['--wa-carbon'])).toBeGreaterThanOrEqual(3);
    }
    expect(contrast(BRAND_TOKENS['--wa-indigo'], BRAND_TOKENS['--wa-cloud'])).toBeGreaterThanOrEqual(3);
    expect(contrast(BRAND_TOKENS['--wa-mist'], BRAND_TOKENS['--wa-carbon'])).toBeGreaterThanOrEqual(3);
    expect(css).toContain('--wa-viz-1-outline: var(--wa-mist)');
    expect(css).toContain('--wa-focus-contrast: var(--wa-mist)');
  });
});
