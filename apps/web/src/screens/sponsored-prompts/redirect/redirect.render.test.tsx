// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { verifyScreen } from '../../render-test-support';
import VirtualScreen from '../../virtual-screen-view';
import { descriptor } from './descriptor';

verifyScreen(descriptor, [{ state: 'ready', name: 'renders no duplicate page for the alias', render: () => <VirtualScreen />, text: '' }]);
it('redirects the legacy route while preserving every query value', async () => {
  const redirect = vi.fn((href: string): never => { throw new Error(href); });
  vi.doMock('next/navigation', () => ({ redirect }));
  const { load } = await import('./load');
  await expect(load({ searchParams: { profile: 'synthetic-profile', from: '2026-06-01', filter: ['one', 'two'] }, params: {} })).rejects.toThrow('/prompts?profile=synthetic-profile&from=2026-06-01&filter=one&filter=two');
  expect(redirect).toHaveBeenCalledWith('/prompts?profile=synthetic-profile&from=2026-06-01&filter=one&filter=two');
  vi.doUnmock('next/navigation');
});
