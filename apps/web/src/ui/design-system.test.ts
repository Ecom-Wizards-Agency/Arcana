import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./theme.css', import.meta.url), 'utf8');
const tokensSource = readFileSync(new URL('./tokens.ts', import.meta.url), 'utf8');

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

  it('declares each title weight once and keeps the base h1 and the inline styles on it', () => {
    const titleWeight = /--wa-fw-title: (\d+);/.exec(css)?.[1];
    const sectionWeight = /--wa-fw-section: (\d+);/.exec(css)?.[1];
    expect(titleWeight).toBe('700');
    expect(sectionWeight).toBe('620');
    expect(css.match(/--wa-fw-title:/g)).toHaveLength(1);
    expect(css.match(/--wa-fw-section:/g)).toHaveLength(1);

    // The element default and the token are the same weight, so an `<h1>` with no
    // class and an `<h1 style={heading}>` cannot disagree. Read from the token so
    // moving the token without moving the base rule fails here.
    expect(css).toContain(`h1 {\n  font-size: var(--wa-fs-xl);\n  font-weight: ${titleWeight};`);

    // `tokens.ts` restates neither weight; both read the custom property.
    expect(tokensSource).toContain("title: 'var(--wa-fw-title)'");
    expect(tokensSource).toContain("section: 'var(--wa-fw-section)'");
    expect(tokensSource).toMatch(/export const heading: CSSProperties = \{[^}]*fontWeight: weight\.title,/);
    expect(tokensSource).toMatch(/export const subheading: CSSProperties = \{[^}]*fontWeight: weight\.section,/);
    // No title-level weight literal survives anywhere in the module.
    expect(tokensSource).not.toMatch(/fontWeight: (?:620|640|700)\b/);
  });

  it('pins the two title weights theme.css still restates, so the handoff cannot drift', () => {
    // `.wa-page-title` and `.wa-section-title` are component rules, outside this
    // package's theme.css scope (token block and warn scopes), so they still carry
    // literals. `.wa-section-title` already agrees with `--wa-fw-section`;
    // `.wa-page-title` does not, and closing that is the handoff recorded in the
    // WP-211 brief close-out. Both are pinned here so no third weight appears and
    // so the gap has to be closed deliberately.
    expect(css).toContain('.wa-page-title {\n  font-size: var(--wa-fs-xl);\n  font-weight: 640;');
    expect(css).toContain('.wa-section-title {\n  font-size: var(--wa-fs-md);\n  font-weight: 620;');
    expect(/--wa-fw-section: (\d+);/.exec(css)?.[1]).toBe('620');
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

/**
 * The brand mark as shipped assets.
 *
 * The mark used to reach a browser as one SVG and nothing else: no PNG for the
 * tabs and installers that will not read a vector, no Apple touch icon, no
 * social card. The three rasters are generated from the vector, which stays the
 * source of truth, so the checks here are about the *shipped* artefacts — a
 * real PNG, at the size the convention expects, big enough not to be a
 * placeholder — and about the wiring that makes Next serve them.
 */
describe('WP-211 brand icon set', () => {
  const appDirectory = new URL('../../app/', import.meta.url);
  const layout = readFileSync(new URL('layout.tsx', appDirectory), 'utf8');

  /** The IHDR chunk, read directly, so no image library is needed to verify one. */
  function pngHeader(file: string): { signature: boolean; width: number; height: number; bytes: number } {
    const bytes = readFileSync(new URL(file, appDirectory));
    return {
      signature: bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
      bytes: bytes.length,
    };
  }

  const EXPECTED = [
    // A favicon large enough that a browser downscales rather than guesses.
    { file: 'icon.png', width: 512, height: 512 },
    // Apple's touch-icon size.
    { file: 'apple-icon.png', width: 180, height: 180 },
    // The 1.91:1 card every link preview crops to.
    { file: 'opengraph-image.png', width: 1200, height: 630 },
  ] as const;

  it('ships each icon as a real PNG at the size its convention expects', () => {
    const measured = EXPECTED.map(({ file }) => ({ file, ...pngHeader(file) }));
    // Counted against the list, not "none threw": a missing file is a failure,
    // and so is a fourth that nobody declared.
    expect(measured.map(({ file, signature, width, height }) => ({ file, signature, width, height }))).toEqual(
      EXPECTED.map((expected) => ({ ...expected, signature: true })),
    );
    // A 1x1 transparent PNG is ~70 bytes and satisfies every check above.
    for (const { file, bytes } of measured) expect(bytes, file).toBeGreaterThan(4096);
  });

  it('names each file exactly as the Next metadata convention does', async () => {
    // Imported rather than restated: if a Next upgrade renames a convention,
    // this fails here instead of silently serving no icon.
    const { STATIC_METADATA_IMAGES } = await import('next/dist/lib/metadata/is-metadata-route.js');
    const conventions = { 'icon.png': 'icon', 'apple-icon.png': 'apple', 'opengraph-image.png': 'openGraph' } as const;
    for (const { file } of EXPECTED) {
      const convention = STATIC_METADATA_IMAGES[conventions[file]];
      const [name, extension] = [file.slice(0, file.lastIndexOf('.')), file.slice(file.lastIndexOf('.') + 1)];
      expect(convention?.filename, file).toBe(name);
      expect(convention?.extensions, file).toContain(extension);
    }
  });

  it('references every icon from the metadata block, and the card from neither', () => {
    // Next merges the collected file-convention icons only when the metadata
    // object declares no `icons` key at all, so an `icons` block that names one
    // icon suppresses the rest. Both PNGs have to appear here by name.
    for (const { file, width } of EXPECTED) {
      if (file === 'opengraph-image.png') continue;
      expect(layout, file).toContain(`{ url: '/${file}', type: 'image/png', sizes: '${width}x${width}' }`);
    }
    expect(layout).toContain("{ url: '/brand/wizards-ai-icon.svg', type: 'image/svg+xml' }");

    // The card is the mirror image: the static file is adopted *unless*
    // `openGraph.images` exists, so this absence is what ships the card.
    expect(layout).not.toMatch(/openGraph:\s*\{[^}]*images/);
    expect(layout).toMatch(/twitter:\s*\{\s*card: 'summary_large_image'/);

    // The vector the rasters were generated from is still the shipped source.
    expect(
      readFileSync(new URL('../../public/brand/wizards-ai-icon.svg', import.meta.url), 'utf8'),
    ).toContain('viewBox="0 0 378 378"');
  });
});
