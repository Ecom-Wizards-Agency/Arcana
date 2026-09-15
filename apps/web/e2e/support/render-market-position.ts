/** Render fixtures outside Playwright's component-testing JSX transformer. */
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { visualFixture, visualStates } from '../../src/screens/market-position/render-fixture';
Object.assign(globalThis, { React });
const { MarketPositionPresentation } = await import('../../src/screens/market-position/presentation');
const { default: Loading } = await import('../../src/screens/shared-loading');
const { default: SharedError } = await import('../../src/screens/shared-error');
const markup = Object.fromEntries(visualStates.map((state) => {
  const data = visualFixture(state);
  const component = state === 'loading' ? createElement(Loading)
    : state === 'error' ? createElement(SharedError, { error: Object.assign(new Error('Synthetic failure'), { digest: 'synthetic-reference' }), reset: () => {} })
    : createElement(MarketPositionPresentation, { data, category: data.series[0]?.category ?? '', threshold: data.settings.thresholdPercent });
  return [state, renderToStaticMarkup(component)];
}));
process.stdout.write(JSON.stringify(markup));
