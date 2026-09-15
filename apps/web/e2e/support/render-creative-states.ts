/** Render real components and their CSS outside Playwright's JSX transformer. */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

Object.assign(globalThis, { React });
const css = new Map<string, string>();
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'next/navigation') return { url: 'wp267:navigation', shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'wp267:navigation') return { format: 'module', shortCircuit: true, source: `
      export const useRouter=()=>({push(){},replace(){},refresh(){}});
      export const useSearchParams=()=>new URLSearchParams();
      export const usePathname=()=>'/creative';
      export const notFound=()=>{throw new Error('Unexpected notFound in a visual fixture')};
      export const redirect=()=>{throw new Error('Unexpected redirect in a visual fixture')};
    ` };
    if (url.endsWith('.css')) {
      const source = readFileSync(fileURLToPath(url), 'utf8');
      const prefix = `wp267_${createHash('sha256').update(source).digest('hex').slice(0, 8)}_`;
      const classes: Record<string, string> = {};
      const transformed = url.endsWith('.module.css')
        ? source.replace(/\.([_a-zA-Z][_a-zA-Z0-9-]*)/g, (_match, name: string) => {
          classes[name] = prefix + name;
          return `.${prefix}${name}`;
        }) : source;
      css.set(url, transformed);
      return { format: 'module', shortCircuit: true, source: `export default ${JSON.stringify(classes)};` };
    }
    return nextLoad(url, context);
  },
});

const screen = process.argv[2];
if (screen !== 'creative' && screen !== 'sponsored-prompts') throw new Error('Choose a creative screen fixture');
interface VisualFixtures {
  visualStates: readonly string[];
  renderVisualFixture(state: string): React.ReactElement;
}
const fixtures = await import(new URL(`../../src/screens/${screen}/render-fixture.tsx`, import.meta.url).href) as VisualFixtures;
if (!Array.isArray(fixtures.visualStates) || typeof fixtures.renderVisualFixture !== 'function') {
  throw new Error(`${screen} must export visualStates and renderVisualFixture`);
}
const markup: Record<string, string> = {};
for (const state of fixtures.visualStates) {
  if (state in markup) throw new Error(`Repeated ${screen} visual state: ${state}`);
  markup[state] = renderToStaticMarkup(fixtures.renderVisualFixture(state));
}
const style = `<style data-wp267-source-styles>${[...css.values()].join('\n')}</style>`;
process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(markup).map(([state, html]) => [state, style + html]))));
