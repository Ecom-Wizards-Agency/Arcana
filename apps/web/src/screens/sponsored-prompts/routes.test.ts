import { afterEach, expect, it, vi } from 'vitest';
import type { AuthenticatedEditorTransaction } from '@wizard-ads/db';
import type * as DbModule from '@wizard-ads/db';
import type * as MutationModule from '../../server/authenticated-mutation';
import type * as ReadModule from '../../server/authenticated-read';
const mocks = vi.hoisted(() => ({ mutate: vi.fn(), read: vi.fn(), importRows: vi.fn(), visit: vi.fn(), snapshot: vi.fn() }));
vi.mock('@wizard-ads/db', async (original) => ({ ...await original<typeof DbModule>(), importSponsoredPrompts: mocks.importRows, recordSponsoredPromptVisit: mocks.visit, readSponsoredPrompts: mocks.snapshot }));
vi.mock('../../server/authenticated-mutation', async (original) => {
  const actual = await original<typeof MutationModule>();
  return { ...actual, authenticatedMutation: async (request: Request, operation: (context: AuthenticatedEditorTransaction) => Promise<Response>) => {
    mocks.mutate(request);
    try { return await operation({} as AuthenticatedEditorTransaction); }
    catch (error) { if (error instanceof actual.MutationInputError || error instanceof SyntaxError) return Response.json({ error: error.message }, { status: 400 }); throw error; }
  } };
});
vi.mock('../../server/authenticated-read', async (original) => {
  const actual = await original<typeof ReadModule>();
  return { ...actual, authenticatedRead: async (request: Request, operation: (database: unknown, actor: unknown) => Promise<Response>) => {
    mocks.read(request); return operation({}, { orgId: '00000000-0000-4000-8000-000000000091', userId: '00000000-0000-4000-8000-000000000092' });
  } };
});
import { POST as importPrompts } from '../../../app/api/prompts/import/route';
import { POST as visitPrompts } from '../../../app/api/prompts/visit/route';
import { GET as getPrompts } from '../../../app/api/prompts/route';
const profileId = '00000000-0000-4000-8000-000000000093';
const request = (path: string, body: unknown) => new Request(`http://localhost/api/prompts/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
it('gates all prompt APIs inside the authenticated boundary when rollout is off', async () => {
  vi.stubEnv('WIZARD_ADS_PROMPTS_ENABLED', 'false');
  expect((await importPrompts(request('import', {}))).status).toBe(404);
  expect((await visitPrompts(request('visit', {}))).status).toBe(404);
  expect((await getPrompts(new Request(`http://localhost/api/prompts?profile=${profileId}`))).status).toBe(404);
  expect(mocks.mutate).toHaveBeenCalledTimes(2); expect(mocks.read).toHaveBeenCalledOnce();
  expect(mocks.importRows).not.toHaveBeenCalled(); expect(mocks.visit).not.toHaveBeenCalled(); expect(mocks.snapshot).not.toHaveBeenCalled();
});
it('bounds streamed import bodies and rejects cumulative export semantics before persistence', async () => {
  vi.stubEnv('WIZARD_ADS_PROMPTS_ENABLED', 'true');
  expect((await importPrompts(request('import', { payload: 'x'.repeat(2 * 1024 * 1024) }))).status).toBe(400);
  expect((await importPrompts(request('import', { profileId, metricSemantics: 'cumulative', rows: [] }))).status).toBe(400);
  expect(mocks.importRows).not.toHaveBeenCalled();
});
it('reads without marking visits and sends visit writes only through POST', async () => {
  vi.stubEnv('WIZARD_ADS_PROMPTS_ENABLED', '1'); mocks.snapshot.mockResolvedValue({ profileId });
  expect((await getPrompts(new Request(`http://localhost/api/prompts?profile=${profileId}`))).status).toBe(200);
  expect(mocks.visit).not.toHaveBeenCalled();
  const viewedThrough = '2026-06-02T00:00:00.000Z'; mocks.visit.mockResolvedValue({ profileId, viewedThrough });
  expect((await visitPrompts(request('visit', { profileId, viewedThrough }))).status).toBe(200);
  expect(mocks.visit).toHaveBeenCalledWith(expect.anything(), { profileId, viewedThrough });
});
