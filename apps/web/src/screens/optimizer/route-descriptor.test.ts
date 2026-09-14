import { expect, it } from 'vitest';
import { descriptor } from '../optimizer-calculation/descriptor';
import { optimizerRouteDescriptor } from './route-descriptor';

it('encodes each dynamic value without letting it inject a path, query or fragment', () => {
  const bound = optimizerRouteDescriptor(descriptor, { batchId: 'synthetic/batch', rowId: 'synthetic?row#fragment' });
  const address = new URL(bound.path, 'https://example.test');
  expect(address.pathname.split('/')).toEqual(['', 'optimizer', 'review', 'synthetic%2Fbatch', 'calculation', 'synthetic%3Frow%23fragment']);
  expect(address.search).toBe('');
  expect(address.hash).toBe('');
  expect(descriptor.path.split('/')).toEqual(['', 'optimizer', 'review', '[batchId]', 'calculation', '[rowId]']);
  expect(bound).toEqual({ ...descriptor, path: bound.path });
});

it('refuses absent or empty route identities before the shared reader can canonicalize a template', () => {
  expect(() => optimizerRouteDescriptor(descriptor, {})).toThrow('Missing optimizer route parameter: batchId');
  expect(() => optimizerRouteDescriptor(descriptor, { batchId: 'synthetic', rowId: '' })).toThrow('Missing optimizer route parameter: rowId');
  expect(() => optimizerRouteDescriptor(descriptor, Object.create({ batchId: 'synthetic', rowId: 'inherited' }))).toThrow('Missing optimizer route parameter: batchId');
});
