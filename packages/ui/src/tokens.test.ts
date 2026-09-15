import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateTokens } from '../scripts/generate-tokens.js';
import { tokenNames, tokenValues } from './tokens.generated.js';

describe('shared token source', () => {
  const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');
  it('keeps generated values current and accounts for every declaration', () => {
    expect(readFileSync(new URL('./tokens.generated.ts', import.meta.url), 'utf8')).toBe(generateTokens(css));
    const names = [...new Set([...css.matchAll(/(--wa-[\w-]+)\s*:/g)].map((match) => match[1]))].sort();
    expect(tokenNames).toEqual(names);
    expect(Object.keys(tokenValues.dark)).toEqual(names);
  });
  it('imports tokens once and leaves no declarations in app component CSS', () => {
    const appCss = readFileSync(new URL('../../../apps/web/src/ui/theme.css', import.meta.url), 'utf8');
    expect(appCss.match(/^\s*--wa-/gm) ?? []).toHaveLength(0);
    expect(appCss.match(/@import .*tokens.css/g)).toHaveLength(1);
  });
});
