import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXPENSIVE_ROUTE_PATHNAMES } from '../performance/routes';
import { navigationFor } from '../ui/nav-links';
import { SCREEN_GROUPS, SCREEN_REGISTRY } from './registry';
import { SCREEN_REGISTRY as metadata } from './registry-metadata';
import { screenEnabled } from './types';

const app = fileURLToPath(new URL('../../app/', import.meta.url));
function pageFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? pageFiles(join(directory, entry.name)) : entry.name === 'page.tsx' ? [join(directory, entry.name)] : [],
  );
}
function frozen(path: string): boolean {
  return /^\/(login|forgot-password|recover-password)$/.test(path)
    || /^\/auth(?:\/|$)/.test(path)
    || /^\/(invite|agency-invite|go)\/\[token\]$/.test(path);
}
function routePath(file: string): string {
  const directory = relative(app, file).replace(/(?:^|\/)page\.tsx$/, '')
    .split('/').filter((segment) => !segment.startsWith('(')).join('/');
  return directory === '' ? '/' : `/${directory}`;
}
const filesByPath = new Map(pageFiles(app).map((file) => [routePath(file), file]));
const physical = SCREEN_REGISTRY.filter((screen) => screen.route === 'page' || screen.route === 'redirect');

describe('screen registry conservation', () => {
  it('keeps the generated runtime metadata equal to every descriptor without importing screen implementations', () => {
    expect(metadata).toEqual(JSON.parse(JSON.stringify(SCREEN_REGISTRY)));
    const source = readFileSync(new URL('./registry-metadata.ts', import.meta.url), 'utf8');
    const imports = source.split('\n').filter((line) => line.startsWith('import') || line.startsWith('export {'));
    expect(imports).toEqual([
      "import type { ScreenMetadata } from './types';",
      "export { SCREEN_GROUPS } from './groups';",
    ]);
    for (const file of [
      '../../next.config.ts', '../ui/nav-links.ts', '../performance/routes.ts',
      '../server/page-read.ts', '../e2e-guard-routes.ts', '../e2e-suite-registry.ts',
    ]) {
      const consumer = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(consumer, file).toContain('screens/registry-metadata');
      expect(consumer, file).not.toMatch(/screens\/registry['"]/);
    }
  });
  it('owns every non-frozen page exactly once and every physical descriptor has a page', () => {
    const paths = pageFiles(app).map(routePath).filter((path) => !frozen(path)).sort();
    expect(physical.map((screen) => screen.path).sort()).toEqual(paths);
    expect(new Set(physical.map((screen) => screen.path)).size).toBe(paths.length);
    expect(new Set(SCREEN_REGISTRY.map((screen) => screen.id)).size).toBe(SCREEN_REGISTRY.length);
    const modules = readdirSync(fileURLToPath(new URL('.', import.meta.url)), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(new URL(`./${entry.name}/descriptor.ts`, import.meta.url)))
      .map((entry) => entry.name).sort();
    expect(SCREEN_REGISTRY.map((screen) => screen.id).sort()).toEqual(modules);
    expect(new Set(SCREEN_REGISTRY.map((screen) => screen.path)).size).toBe(SCREEN_REGISTRY.length);
    expect(SCREEN_REGISTRY.some((screen) => frozen(screen.path))).toBe(false);
  });

  it('permits missing page files only for disabled plans and Grid query presets', () => {
    for (const screen of SCREEN_REGISTRY.filter((screen) => screen.route === 'planned')) {
      expect(screen.rollout.enabled, screen.id).toBe(false);
      expect(screenEnabled(screen, {}), screen.id).toBe(false);
      expect(existsSync(join(app, screen.path, 'page.tsx'))).toBe(false);
    }
    for (const screen of SCREEN_REGISTRY.filter((screen) => screen.route === 'preset')) {
      const url = new URL(screen.path, 'https://example.test');
      expect(url.pathname).toBe('/grid');
      expect(url.searchParams.get('entity')).toBeTruthy();
      expect(physical.some((owner) => owner.path === url.pathname)).toBe(true);
    }
  });

  it('binds each query-preserving alias to one enabled physical destination', () => {
    const aliases = SCREEN_REGISTRY.filter((screen) => screen.redirectTo !== undefined);
    expect(aliases.length).toBeGreaterThan(0);
    for (const screen of aliases) {
      expect(screen.route).toBe('redirect');
      expect(screen.entry).toBe('redirect');
      expect(screen.path).not.toBe(screen.redirectTo);
      expect(physical.filter((target) => target.path === screen.redirectTo && target.rollout.enabled)).toHaveLength(1);
    }
  });

  it('counts loading, error, thin adapters and render tests against all physical routes', () => {
    for (const screen of physical) {
      const folder = join(filesByPath.get(screen.path)!, '..');
      for (const state of ['loading', 'error']) expect(existsSync(join(folder, `${state}.tsx`)), `${screen.path}/${state}`).toBe(true);
      const adapter = readFileSync(join(folder, 'page.tsx'), 'utf8');
      expect(adapter).toContain('pageRead(descriptor, searchParams, params)');
      expect(adapter).not.toMatch(/\bgate\(|\bopenWebDatabase\(|\brequestActor\(|\bauthenticatedPageRead\(/);
      expect(existsSync(new URL(`./${screen.id}/${screen.id}.render.test.tsx`, import.meta.url)), screen.id).toBe(true);
    }
    const tests = readdirSync(fileURLToPath(new URL('.', import.meta.url)), { recursive: true })
      .filter((file) => typeof file === 'string' && file.endsWith('.render.test.tsx'));
    expect(tests).toHaveLength(physical.length);
  });

  it('derives navigation, every placement and the prefetch budget from descriptors', () => {
    const groups = navigationFor(SCREEN_REGISTRY, {});
    const navigable = SCREEN_REGISTRY.filter((screen) => screen.nav !== null && screenEnabled(screen, {}));
    expect(groups.flatMap((group) => group.links.map((link) => link.href)).sort()).toEqual(navigable.map((screen) => screen.path).sort());
    for (const group of groups) {
      expect(group.placement).toBe(SCREEN_GROUPS.find((definition) => definition.id === group.id)?.placement);
      expect(group.links.map((link) => link.href)).toEqual(navigable.filter((screen) => screen.nav?.group === group.id)
        .sort((left, right) => (left.nav?.order ?? 0) - (right.nav?.order ?? 0)).map((screen) => screen.path));
    }
    expect([...EXPENSIVE_ROUTE_PATHNAMES].sort()).toEqual([...new Set(SCREEN_REGISTRY.filter((screen) => screen.prefetch === 'expensive').map((screen) => screen.path.split('?')[0]))].sort());
  });

  it('hides disabled routes and uses the same explicit flag semantics as page admission', () => {
    const home = SCREEN_REGISTRY.find((screen) => screen.id === 'cockpit')!;
    const candidate = { ...home, rollout: { enabled: false, envFlag: 'SYNTHETIC_SCREEN_FLAG' } };
    expect(navigationFor([candidate], {})).toEqual([]);
    for (const value of ['0', 'false', 'unexpected', '']) expect(screenEnabled(candidate, { SYNTHETIC_SCREEN_FLAG: value })).toBe(false);
    for (const value of ['1', 'true']) expect(navigationFor([candidate], { SYNTHETIC_SCREEN_FLAG: value }).flatMap((group) => group.links)).toHaveLength(1);
    expect(screenEnabled({ rollout: { enabled: true } }, {})).toBe(true);
  });
});
