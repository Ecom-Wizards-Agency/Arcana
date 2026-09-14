/** Synthetic screen markup for the browser's light/dark geometry checks. */
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { ready, restore } from './render-fixture';
import Queue from './queue';
Object.assign(globalThis,{React});
const router={bfcacheId:'synthetic-preview',back(){},forward(){},refresh(){},hmrRefresh(){},push(){},replace(){},prefetch(){}};
process.stdout.write(JSON.stringify(Object.fromEntries([['change-queue',ready],['restore-preview',restore]].map(([key,data])=>[
  key,renderToStaticMarkup(createElement(AppRouterContext.Provider,{value:router},createElement(Queue,{data: data as typeof ready | typeof restore}))),
]))));
