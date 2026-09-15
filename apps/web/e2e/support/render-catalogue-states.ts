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
    if (specifier === 'next/navigation') return { url: 'catalogue-visual:navigation', shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'catalogue-visual:navigation') return { format: 'module', shortCircuit: true, source: `
      export const useRouter=()=>({push(){},replace(){},refresh(){}});
      export const useSearchParams=()=>new URLSearchParams();
      export const usePathname=()=>'/creative';
      export const notFound=()=>{throw new Error('Unexpected notFound in a visual fixture')};
      export const redirect=()=>{throw new Error('Unexpected redirect in a visual fixture')};
    ` };
    if (url.endsWith('.css')) {
      const source = readFileSync(fileURLToPath(url), 'utf8');
      const prefix = `catalogue-visual_${createHash('sha256').update(source).digest('hex').slice(0, 8)}_`;
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

const [{CatalogueProducts},{ProductShelf},{catalogueEvidenceFixtures,amazonEntryFixtures},{listingHistoryFixture},{default:Creative},{catalogueReady:syncData},{default:Sync},{ready:queueReady},{default:Queue},{catalogueReady:timelineData},{default:Timeline}]=await Promise.all([
  import('../../src/screens/grid/catalogue-products'),import('../../src/screens/targets/product-shelf'),import('../../src/screens/grid/catalogue-fixtures'),
  import('../../src/screens/creative/render-fixture'),import('../../src/screens/creative-detail/view'),import('../../src/screens/sync-status/render-fixture'),import('../../src/screens/sync-status/view'),
  import('../../src/screens/time-machine/render-fixture'),import('../../src/screens/time-machine/queue'),import('../../src/screens/timeline/render-fixture'),import('../../src/screens/timeline/view'),
]);
const products=catalogueEvidenceFixtures();
const views={
  products:React.createElement(CatalogueProducts,{data:{products,missingScopeAsins:[],advertisedIdentities:9,scopedRows:9,truncated:false}}),
  shelf:React.createElement(ProductShelf,{products}),
  creative:React.createElement(Creative,{data:listingHistoryFixture()}),
  sync:React.createElement(Sync,{data:syncData}),
  'time-machine':React.createElement(Queue,{data:{...queueReady,props:{...queueReady.props,entries:[queueReady.props.entries[0]!,...amazonEntryFixtures()]}}}),
  timeline:React.createElement(Timeline,{data:timelineData}),
};
const markup=Object.fromEntries(Object.entries(views).map(([name,view])=>[name,renderToStaticMarkup(view)]));
const style=`<style>${[...css.values()].join('\n')}</style>`;
process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(markup).map(([name,html])=>[name,style+html]))));
