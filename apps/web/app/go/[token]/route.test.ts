import { afterEach, expect, it, vi } from 'vitest';
import type * as database from '@wizard-ads/db';
import { serializeGridView } from '@wizard-ads/shared';
import { GET } from './route';
const seam = vi.hoisted(() => ({ consume: vi.fn(), close: vi.fn() }));
vi.mock('@wizard-ads/db', async (original) => ({
  ...await original<typeof database>(), consumeGotoLinkForActor: seam.consume,
}));
vi.mock('../../../src/server/request-context', () => ({
  requestActor: async () => ({ orgId: 'synthetic-org', userId: 'synthetic-user' }),
  openWebDatabase: () => ({ close: seam.close }),
}));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
it('keeps a redeemed analysis on the public origin that owns the session cookie', async () => {
  vi.stubEnv('WIZARD_ADS_APP_URL', 'https://app.example.test');
  vi.stubEnv('GOTO_LINK_SIGNING_SECRET', 'synthetic-value');
  const view = serializeGridView({ id: 'one', name: 'Synthetic', entity: 'targets', columns: [], pinned: [], widths: {}, filter: { groups: [] }, sort: [], groupBy: [], dateRange: null, updatedAt: '' });
  seam.consume.mockResolvedValue({ route: '/grid?entity=targets', state: { view } });
  const result = await GET(new Request('http://localhost/go/synthetic'), { params: Promise.resolve({ token: 'synthetic' }) });
  expect(result.status).toBe(307);
  const location = new URL(result.headers.get('location')!);
  expect(location.origin).toBe('https://app.example.test');
  expect(location.searchParams.get('view')).toBe(view);
  expect(seam.consume).toHaveBeenCalledTimes(1); expect(seam.close).toHaveBeenCalledTimes(1);
});
