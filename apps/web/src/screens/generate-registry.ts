/** Run after changing a descriptor. Generate inventories and missing boundaries. */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const screens = fileURLToPath(new URL('.', import.meta.url));
const app = fileURLToPath(new URL('../../app/', import.meta.url));
const registry = join(screens, 'registry.ts');
const source = readFileSync(registry, 'utf8');
const ids = readdirSync(screens, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(screens, entry.name, 'descriptor.ts')))
  .map((entry) => entry.name).sort();
const symbol = (id: string): string => id.replaceAll('-', '_');
const next = [
  '// Generated imports: run src/screens/generate-registry.ts after adding a descriptor.',
  "import type { ScreenMetadata } from './types';",
  ...ids.map((id) => `import { descriptor as ${symbol(id)} } from './${id}/descriptor';`),
  '',
  '/** The single inventory of physical pages, query presets and disabled planned screens. */',
  'export const SCREEN_REGISTRY: readonly ScreenMetadata[] = [',
  ...ids.map((id) => `  ${symbol(id)},`),
  '];',
  '',
  "export { SCREEN_GROUPS } from './groups';",
  '',
].join('\n');
if (next !== source) writeFileSync(registry, next);

// Next follows even lazy descriptor imports when collecting client references.
// Runtime projections must contain data alone or every page ships every screen.
const metadata = await Promise.all(ids.map(async (id) => {
  const { descriptor } = await import(`./${id}/descriptor.ts`);
  const { load: _load, client: _client, ...fields } = descriptor;
  return fields;
}));
const metadataFile = join(screens, 'registry-metadata.ts');
const metadataSource = [
  '// Generated from descriptors by src/screens/generate-registry.ts. Do not edit.',
  "import type { ScreenMetadata } from './types';",
  "export { SCREEN_GROUPS } from './groups';",
  '',
  '/** Data-only projection: no imports of screen loaders or client references. */',
  'export const SCREEN_REGISTRY: readonly ScreenMetadata[] = [',
  ...metadata.map((screen) => `  ${JSON.stringify(screen)},`),
  '];',
  '',
].join('\n');
if (!existsSync(metadataFile) || readFileSync(metadataFile, 'utf8') !== metadataSource) {
  writeFileSync(metadataFile, metadataSource);
}

function pages(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? pages(join(directory, entry.name)) : entry.name === 'page.tsx' ? [join(directory, entry.name)] : [],
  );
}
let boundaries = 0;
for (const page of pages(app)) {
  const route = relative(app, page).split('/').filter((segment) => !segment.startsWith('(')).join('/');
  if (/^(auth|login|forgot-password|recover-password|invite|agency-invite|go)\//.test(route)) continue;
  for (const state of ['loading', 'error']) {
    const file = join(dirname(page), `${state}.tsx`);
    if (existsSync(file)) continue;
    const imported = relative(dirname(page), join(screens, `shared-${state}`));
    writeFileSync(file, `${state === 'error' ? "'use client';\n" : ''}export { default } from '${imported}';\n`);
    boundaries++;
  }
}
console.log(`Registered ${ids.length} descriptors; added ${boundaries} missing boundaries.`);
