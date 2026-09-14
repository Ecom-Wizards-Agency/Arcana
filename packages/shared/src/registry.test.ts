import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { PACKAGE_REGISTRY, generatedBarrels } from './registry.js';

it('keeps generated barrels current', () => {
  const generated = generatedBarrels();
  const targets = [...new Set(PACKAGE_REGISTRY.flatMap((entry) => entry.exports.map((item) => item.barrel)))];
  expect(Object.keys(generated).sort()).toEqual(targets.sort());
  expect(targets.length).toBeGreaterThan(0);
  for (const [path, expected] of Object.entries(generated)) {
    const url = new URL(path, import.meta.url);
    if (process.env['UPDATE_PACKAGE_BARRELS'] === '1') writeFileSync(url, expected);
    expect(readFileSync(url, 'utf8'), `Run pnpm generate:barrels (${path})`).toBe(expected);
  }
});

it('registers every domain on disk, including intentional internal and subpath modules', () => {
  const files = readdirSync(new URL('.', import.meta.url), { recursive: true })
    .map(String)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && !['index.ts', 'registry.ts'].includes(file))
    .sort();
  const registered = PACKAGE_REGISTRY.flatMap((entry) => [entry.contract, entry.schema, entry.queries])
    .filter((path): path is string => path !== null);
  expect(registered.sort()).toEqual(files);
  expect(new Set(PACKAGE_REGISTRY.map((entry) => entry.domain)).size).toBe(PACKAGE_REGISTRY.length);
});
