import { expect, it } from 'vitest';
import { MethodSelection } from '@wizard-ads/shared';
import { OPTIMIZATION_METHOD_CATALOGUE } from './catalogue.js';
import { resolveMethod } from './registry.js';

it('lists exactly nine methods while preserving the two registered selections', () => {
  expect(OPTIMIZATION_METHOD_CATALOGUE).toHaveLength(9);
  expect(new Set(OPTIMIZATION_METHOD_CATALOGUE.map((entry) => entry.id)).size).toBe(9);
  expect(OPTIMIZATION_METHOD_CATALOGUE.map((entry) => entry.releaseState)).toEqual(['stable', 'shadow', ...Array<string>(7).fill('draft')]);
  for (const entry of OPTIMIZATION_METHOD_CATALOGUE) {
    const selection = MethodSelection.safeParse(entry);
    expect(selection.success).toBe(entry.releaseState !== 'draft');
    if (selection.success) expect(resolveMethod(selection.data.id, selection.data.version).descriptor.releaseState).toBe(entry.releaseState);
  }
});
