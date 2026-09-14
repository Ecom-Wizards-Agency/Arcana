import { afterEach, expect, it, vi } from 'vitest';
import { isValidElement } from 'react';
import { pageRead } from '../../server/page-read';

vi.mock('../../server/page-read', () => ({ pageRead: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

const routes = [
  { name: 'choose', page: () => import('../../../app/optimizer/page'), descriptor: () => import('./descriptor') },
  { name: 'settings', page: () => import('../../../app/optimizer/settings/page'), descriptor: () => import('../optimizer-settings/descriptor') },
  { name: 'review', page: () => import('../../../app/optimizer/review/[batchId]/page'), descriptor: () => import('../optimizer-review/descriptor') },
  { name: 'calculation', page: () => import('../../../app/optimizer/review/[batchId]/calculation/[rowId]/page'), descriptor: () => import('../optimizer-calculation/descriptor') },
  { name: 'confirm', page: () => import('../../../app/optimizer/confirm/[batchId]/page'), descriptor: () => import('../optimizer-confirm/descriptor') },
  { name: 'results', page: () => import('../../../app/optimizer/run/[batchId]/page'), descriptor: () => import('../optimizer-run/descriptor') },
  { name: 'help', page: () => import('../../../app/optimizer/help/page'), descriptor: () => import('../optimizer-help/descriptor') },
  { name: 'groups', page: () => import('../../../app/optimizer/groups/page'), descriptor: () => import('../optimizer-groups/descriptor') },
  { name: 'group', page: () => import('../../../app/optimizer/groups/[groupId]/page'), descriptor: () => import('../optimizer-group/descriptor') },
  { name: 'group settings', page: () => import('../../../app/optimizer/groups/[groupId]/settings/page'), descriptor: () => import('../optimizer-group-settings/descriptor') },
  { name: 'methods', page: () => import('../../../app/settings/strategy/page'), descriptor: () => import('../methods/descriptor') },
  { name: 'strategy redirect', page: () => import('../../../app/strategy/page'), descriptor: () => import('../strategy/descriptor') },
];

const routeParams: Record<string, string> = {
  batchId: '00000000-0000-4000-8000-000000000271',
  rowId: '00000000-0000-4000-8000-000000000272',
  groupId: '00000000-0000-4000-8000-000000000273',
};

it.each(routes)('$name adapter gives React the client boundary without invoking it on the server', async (route) => {
  const { descriptor } = await route.descriptor();
  const originalPath = descriptor.path;
  const ClientScreen = vi.fn(() => null);
  vi.spyOn(descriptor, 'client').mockResolvedValue(ClientScreen);
  const data = { view: 'synthetic-boundary-test' };
  vi.mocked(pageRead).mockClear().mockResolvedValue(data);
  const { default: Page } = await route.page();
  const searchParams = Promise.resolve({ from: '2026-08-01', to: '2026-08-26', detail: 'retained' });
  const params = Promise.resolve(routeParams);
  const element = await Page({ searchParams, params });
  expect(isValidElement(element)).toBe(true);
  expect(element.type).toBe(ClientScreen);
  expect(element.props).toEqual({ data });
  expect(ClientScreen).not.toHaveBeenCalled();
  expect(pageRead).toHaveBeenCalledTimes(1);
  const [bound, receivedQuery, receivedParams] = vi.mocked(pageRead).mock.calls[0]!;
  const expectedPath = originalPath.split('/').map((segment) => segment.startsWith('[')
    ? routeParams[segment.slice(1, -1)] : segment).join('/');
  expect(bound).toEqual({ ...descriptor, path: expectedPath });
  expect(bound.guard).toBe(descriptor.guard);
  expect(bound.load).toBe(descriptor.load);
  expect(bound.client).toBe(descriptor.client);
  expect(receivedQuery).toBe(searchParams);
  expect(receivedParams).toBe(params);
  expect(descriptor.path).toBe(originalPath);
  if (originalPath.includes('[')) expect(bound).not.toBe(descriptor);
  else expect(bound).toBe(descriptor);
});
