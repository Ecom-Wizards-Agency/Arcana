/** Synthetic screen markup for the browser's light/dark geometry checks. */
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { ready, restore } from './render-fixture';
import Queue from './queue';
import { optimizerBatchHref } from '../optimizer/navigation';
Object.assign(globalThis,{React});
const router={bfcacheId:'synthetic-preview',back(){},forward(){},refresh(){},hmrRefresh(){},push(){},replace(){},prefetch(){}};
const restoreBatches = { ...ready, props: { ...ready.props, entries: ready.props.entries.map((row, index) => ({ ...row, source: 'restore' as const, state: (['awaiting review', 'admitted', 'attempted', 'succeeded', 'failed', 'observed'] as const)[index]!, batchId: ready.props.entries[0]!.batchId, batchLabel: '1042', batchCount: 2, candidateCount: 1, entity: `Synthetic restore batch ${index + 1}`, reviewHref: optimizerBatchHref('confirm', ready.props.entries[0]!.batchId!, ready.props.profileId) })) } };
process.stdout.write(JSON.stringify(Object.fromEntries([['change-queue',ready],['restore-preview',restore],['restore-batches',restoreBatches]].map(([key,data])=>[
  key,renderToStaticMarkup(createElement(AppRouterContext.Provider,{value:router},createElement(Queue,{data: data as typeof ready | typeof restore}))),
]))));
