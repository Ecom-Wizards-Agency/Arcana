/** Static visual scenarios use the production components and synthetic inputs. */
import { registerHooks } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/navigation') return {
      url: 'data:text/javascript,export const useRouter=()=>({refresh(){},push(){},replace(){}});export const useSearchParams=()=>new URLSearchParams();export const usePathname=()=>"/";',
      shortCircuit: true
    };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith('.css')) return {
      format: 'module',
      source: 'export default new Proxy({}, {get:(_,key)=>String(key)});',
      shortCircuit: true
    };
    return next(url, context);
  }
});
Object.assign(globalThis, { React });
const { researchVisuals } = await import('./research-visuals');
const screen = process.argv[2] as 'queries' | 'ngrams' | 'dayparting' | 'brand-lens';
process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(researchVisuals(screen)).map(([name, component]) => [name, renderToStaticMarkup(component)]))));
