import { expect, it, vi } from 'vitest';
const calls = vi.hoisted(() => ({ read: vi.fn(async () => null), used: vi.fn(async () => []), queue: vi.fn(async () => ({ jobId: '27000000-0000-4000-8000-000000000003', requested: 1, enqueued: 1, alreadyQueued: 0 })) }));
vi.mock('@wizard-ads/db', async (original) => ({ ...await original<object>(), readAssetLibrarySnapshot: calls.read, listUsedCampaignCreatives: calls.used, requestAssetLibraryRefresh: calls.queue }));
vi.mock('../server/authenticated-read', () => ({ authenticatedRead: (_request: Request, run: (context: object) => Promise<Response>) => run({}), readUuid: (raw: unknown) => raw }));
vi.mock('../server/authenticated-mutation', () => ({ authenticatedMutation: (_request: Request, run: (context: object) => Promise<Response>) => run({}), mutationBody: (request: Request) => request.json(), mutationUuid: (raw: unknown) => raw }));
import { GET, POST } from '../../app/api/campaigns/assets/route';
it('reads persisted snapshots and admits refresh through the authenticated queue helper', async () => {
  const profileId = '27000000-0000-4000-8000-000000000002';
  const read = await GET(new Request(`http://localhost/api/campaigns/assets?profileId=${profileId}`));
  expect(await read.json()).toEqual({ snapshot: null, used: [] }); expect(calls.queue).not.toHaveBeenCalled();
  const response = await POST(new Request('http://localhost/api/campaigns/assets', { method: 'POST', body: JSON.stringify({ profileId }) }));
  expect(response.status).toBe(202); expect(await response.json()).toMatchObject({ requested: 1, enqueued: 1, alreadyQueued: 0 });
  expect(calls.queue).toHaveBeenCalledWith({}, profileId);
});
