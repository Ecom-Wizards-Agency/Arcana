import { afterEach, expect, it, vi } from 'vitest';
import type { AuthenticatedEditorTransaction } from '@wizard-ads/db';
import type * as DbModule from '@wizard-ads/db';
import { TARGET_EXPRESSION_TYPES } from '@wizard-ads/shared';
import type * as MutationModule from '../../../src/server/authenticated-mutation';
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@wizard-ads/db', async (original) => ({ ...await original<typeof DbModule>(), requestTargetTranslation: mocks.request }));
vi.mock('../../../src/server/json-mutation', async (original) => ({ ...await original<object>(), readJsonMutation: (request: Request) => request.json() }));
vi.mock('../../../src/server/authenticated-mutation', async (original) => {
  const actual = await original<typeof MutationModule>();
  return { ...actual, authenticatedMutation: async (_request: Request, operation: (context: AuthenticatedEditorTransaction) => Promise<Response>) => {
    try { return await operation({} as AuthenticatedEditorTransaction); }
    catch (error) { if (error instanceof actual.MutationInputError) return Response.json({ error: error.message }, { status: error.status }); throw error; }
  } };
});
import { POST } from './route';

const profileId = '00000000-0000-4000-8000-000000000093';
const post = (originalText: string) => POST(new Request('http://localhost/api/translation', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ profileId, originalText, language: 'en' }) }));
afterEach(() => { vi.clearAllMocks(); });

it('refuses every unambiguous expression before anything is queued', async () => {
  const refused = [
    ...TARGET_EXPRESSION_TYPES,
    'asin="B000SYN267"', 'category="000000001"', 'close-match', 'loose-match', 'asin-expanded="B000SYN268"',
  ];
  expect(refused).toHaveLength(TARGET_EXPRESSION_TYPES.length + 5);
  for (const text of refused) {
    const response = await post(text);
    expect(response.status, text).toBe(400);
    expect(await response.json(), text).toEqual({ error: 'Only keyword phrases are translated' });
  }
  expect(mocks.request).not.toHaveBeenCalled();
});

it('queues keyword phrases that look like codes or words, one row each', async () => {
  const keywords = ['synthetic running shoes', 'iPhone', 'airPods', 'Brand', 'USB_C', 'co_sleeper', '1080', 'co-sleeper', 'complements'];
  for (const [index, text] of keywords.entries()) {
    const row = { synthetic: index };
    mocks.request.mockResolvedValueOnce(row);
    const response = await post(text);
    expect(response.status, text).toBe(200);
    expect(await response.json(), text).toEqual({ row, count: 1 });
    expect(mocks.request.mock.calls[index]![1], text).toEqual({ profileId, originalText: text, language: 'en' });
  }
  expect(mocks.request).toHaveBeenCalledTimes(keywords.length);
});
