import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRequestDatabase, createFeedbackItem, type RequestDatabase } from '@wizard-ads/db';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import { feedbackMutationResponse } from './feedback/mutation-http';
import * as context from './server/request-context';

const available = await databaseAvailable();
const bridge = 'synthetic-feedback-lifecycle-bridge';

describe.skipIf(!available)('feedback HTTP commit and close lifecycle', () => {
  let database: TestDatabase;
  const userId = randomUUID();
  let orgId: string;
  beforeAll(async () => {
    database = await createTestDatabase('feedback_http_lifecycle');
    const [org] = await database.sql<{ id: string }[]>`
      select app.seed_tenant_fixture(${randomUUID()}, ${userId}, 'owner') as id
    `;
    orgId = org!.id;
    vi.stubEnv('WIZARD_ADS_E2E_AUTH_BRIDGE', '1');
    vi.stubEnv('WIZARD_ADS_AUTH_BRIDGE_SECRET', bridge);
  }, 60_000);
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { vi.unstubAllEnvs(); await database?.drop(); });

  function request(authenticated = true) {
    return new Request('http://localhost/api/feedback', { method: 'POST', headers: {
      'x-wizard-ads-auth-bridge': authenticated ? bridge : 'wrong-bridge',
      'x-wizard-ads-user-id': userId, 'x-wizard-ads-org-id': orgId,
    } });
  }
  function privateHeaders(response: Response) {
    expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    expect(response.headers.get('vary')).toBe('Cookie, Authorization');
  }

  it('authenticates before preparing input or opening a mutation connection', async () => {
    const open = vi.spyOn(context, 'openWebDatabase');
    const prepare = vi.fn(() => { throw new Error('Input must remain unread'); });
    const response = await feedbackMutationResponse(request(false), prepare);
    expect(response.status).toBe(401);
    privateHeaders(response);
    expect(prepare).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it.each(['success', 'serialization', 'close'] as const)(
    '%s closes after the real vote commits and never repeats the toggle', async (failure) => {
      const item = await createFeedbackItem(database, {
        orgId, authorId: userId, type: 'feature', title: `Synthetic lifecycle ${randomUUID()}`,
      });
      const application = `feedback-lifecycle-${randomUUID()}`;
      const url = new URL(database.connectionString);
      url.searchParams.set('application_name', application);
      const handle = createRequestDatabase(url.toString());
      let closed = 0;
      let committedAtClose = 0;
      const requestHandle: RequestDatabase = { ...handle, close: async () => {
        closed++;
        const [row] = await database.sql<{ count: number }[]>`
          select count(*)::int as count from public.feedback_votes
           where org_id=${orgId} and item_id=${item.id} and user_id=${userId}
        `;
        committedAtClose = row!.count;
        await handle.close();
        if (failure === 'close') throw new Error('Synthetic private connection failure');
      } };
      const open = vi.spyOn(context, 'openWebDatabase').mockReturnValue(requestHandle);
      if (failure === 'serialization') {
        vi.spyOn(Response, 'json').mockImplementationOnce(() => { throw new Error('Synthetic private serialization failure'); });
      }
      const prepare = vi.fn(() => ({ kind: 'toggleVote' as const, itemId: item.id }));
      try {
        const response = await feedbackMutationResponse(request(), prepare);
        expect(response.status).toBe(failure === 'success' ? 200 : 503);
        privateHeaders(response);
        const body = await response.json();
        expect(body).toEqual(failure === 'success'
          ? { itemId: item.id, voted: true, votes: 1 }
          : { error: 'The save could not be confirmed. Reload before trying again.', code: 'unconfirmed' });
        expect({ closed, committedAtClose }).toEqual({ closed: 1, committedAtClose: 1 });
        expect(open).toHaveBeenCalledTimes(1);
        expect(prepare).toHaveBeenCalledTimes(1);
        expect(await database.sql`
          select user_id from public.feedback_votes where org_id=${orgId} and item_id=${item.id}
        `).toEqual([{ user_id: userId }]);
        expect(await database.sql`
          select pid from pg_stat_activity where datname=current_database() and application_name=${application}
        `).toEqual([]);
      } finally { await handle.close(); }
    },
  );
});
