import { describe, expect, it } from 'vitest';
import { CampaignCreationBatch } from '@wizard-ads/shared';
import { createSpCreationBatchAdapter } from './sp-creation-batch-adapter.js';
import { creationBatch, hasher, id, CAMPAIGN } from './__fixtures__/sp-creation.js';

const CREATED_ID = '900719925474099398765';
const at = Date.parse('2026-09-06T12:03:00.000Z');
function setup(reply: () => Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const adapter = createSpCreationBatchAdapter({ region: 'NA', now: () => at,
    credentials: { clientId: 'synthetic-client', clientSecret: ['synthetic','secret'].join('-'), refreshToken: ['synthetic','refresh'].join('-') },
    retry: { maxAttempts: 5 }, sleep: async () => {},
    fetch: async (url, init) => {
      if (url === 'https://api.amazon.com/auth/o2/token') return Response.json({ access_token: ['synthetic','access'].join('-'), expires_in: 3600 });
      calls.push({ url, ...(init ? { init } : {}) });
      return reply();
    },
  }, hasher);
  const batch = creationBatch();
  const prepared = adapter.prepare(batch, CAMPAIGN);
  batch.nodes[0]!.intent = { id: id(500), requestDigest: prepared.requestDigest,
    nodeRequestDigest: prepared.positions[0]!.requestDigest,
    reservedAt: new Date(at).toISOString(), deadline: new Date(at + 35_000).toISOString() };
  return { adapter, batch, calls };
}

describe('durably reserved creation transport', () => {
  it('sends exactly one paused resource and refuses reuse after a recorded result', async () => {
    const run = setup(async () => Response.json({ campaigns: { success: [{ index: 0, campaignId: CREATED_ID }] } }, { status: 207 }));
    expect(run.calls).toHaveLength(0);
    const result = await run.adapter.execute(run.batch, CAMPAIGN, new AbortController().signal);
    expect(result).toMatchObject({ outcome: 'succeeded', providerEntityId: CREATED_ID });
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]!.url).toBe('https://advertising-api.amazon.com/sp/campaigns');
    const items = JSON.parse(String(run.calls[0]!.init?.body)).campaigns;
    expect(items).toHaveLength(1); expect(items[0].state).toBe('PAUSED');
    run.batch.nodes[0]!.result = result;
    await expect(run.adapter.execute(run.batch, CAMPAIGN, new AbortController().signal)).rejects.toThrow('reservation mismatch');
    expect(run.calls).toHaveLength(1);
  });
  it.each(['timeout','server','ambiguous-body'] as const)('never retries a create after %s', async (failure) => {
    const run = setup(async () => {
      if (failure === 'timeout') throw new TypeError('Synthetic transport timeout');
      return Response.json(failure === 'server' ? {} : { campaigns: { success: [] } }, { status: failure === 'server' ? 503 : 207 });
    });
    const result = await run.adapter.execute(run.batch, CAMPAIGN, new AbortController().signal);
    expect(result).toMatchObject({ outcome: 'ambiguous', providerEntityId: null });
    expect(run.calls).toHaveLength(1);
    run.batch.nodes[0]!.result = result;
    expect((await run.adapter.observe(run.batch, CAMPAIGN, new AbortController().signal)).observation).toBe('pending');
    expect(run.calls).toHaveLength(2);
    expect(run.calls.filter((call) => !call.url.endsWith('/list'))).toHaveLength(1);
  });
  it('reads by the exact returned identity and detects a conflicting state', async () => {
    let read = false;
    let campaign: Record<string, unknown> = {};
    const run = setup(async () => read
      ? Response.json({ campaigns: [{ ...campaign, campaignId: CREATED_ID, state: 'ENABLED' }] })
      : Response.json({ campaigns: { success: [{ index: 0, campaignId: CREATED_ID }] } }, { status: 207 }));
    run.batch.nodes[0]!.result = await run.adapter.execute(run.batch, CAMPAIGN, new AbortController().signal);
    campaign = JSON.parse(String(run.calls[0]!.init?.body)).campaigns[0];
    read = true;
    const observation = await run.adapter.observe(CampaignCreationBatch.parse(run.batch), CAMPAIGN, new AbortController().signal);
    expect(observation).toMatchObject({ providerEntityId: CREATED_ID, observation: 'conflict' });
    expect(run.calls).toHaveLength(2);
    expect(run.calls[1]!.url).toBe('https://advertising-api.amazon.com/sp/campaigns/list');
    expect(JSON.parse(String(run.calls[1]!.init?.body))).toMatchObject({ campaignIdFilter: { include: [CREATED_ID] } });
    expect(String(run.calls[1]!.init?.body)).not.toContain('name');
  });
  it('makes no provider call for an expired reservation', async () => {
    const run = setup(async () => { throw new Error('Must not send'); });
    run.batch.nodes[0]!.intent!.deadline = new Date(at).toISOString();
    expect((await run.adapter.execute(run.batch, CAMPAIGN, new AbortController().signal)).outcome).toBe('ambiguous');
    expect(run.calls).toHaveLength(0);
  });
});
