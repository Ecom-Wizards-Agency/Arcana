import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { StreamConfirmationChallenge, StreamProvisioningIntent, StreamSubscriptionScope } from '@wizard-ads/shared';
import { StreamSubscriptionsClient, validateStreamConfirmation } from './stream-subscriptions.js';

const scope: StreamSubscriptionScope = {
  orgId: '00000000-0000-4000-8000-000000000001', profileId: '00000000-0000-4000-8000-000000000002',
  providerProfileId: 'synthetic-profile', advertiserId: 'synthetic-advertiser', marketplaceId: 'synthetic-market',
  region: 'NA', awsRegion: 'us-east-1', datasetId: 'sb-clickstream',
  destinationArn: 'arn:aws:sqs:us-east-1:000000000000:synthetic-stream',
};
const row = { subscriptionId: 'synthetic-subscription', dataSetId: scope.datasetId,
  destination: { sqsDestination: { queueArn: scope.destinationArn } }, status: 'PENDING_CONFIRMATION',
  createdDate: '2026-09-15T00:00:00Z', updatedDate: '2026-09-15T00:00:00Z' };
const createIntent: Extract<StreamProvisioningIntent, { action: 'create' }> = {
  schemaVersion: 'arcana.stream-provisioning-intent.v1', intentId: scope.orgId, scope,
  createdAt: '2026-09-15T00:00:00Z', action: 'create', clientRequestToken: 'synthetic-request-00000001',
};
function client(responses: unknown[]) {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(responses.shift()), { status: 200 }));
  return { fetch, api: new StreamSubscriptionsClient({ scope, clientId: 'synthetic-client',
    getAccessToken: async () => 'synthetic-access', fetch }) };
}
function confirmation() {
  const token = 'synthetic-confirmation';
  const topicArn = 'arn:aws:sns:us-east-1:000000000000:synthetic-topic';
  const intent: Extract<StreamProvisioningIntent, { action: 'confirm' }> = {
    schemaVersion: 'arcana.stream-provisioning-intent.v1', intentId: scope.orgId, scope,
    createdAt: createIntent.createdAt, action: 'confirm', subscriptionId: row.subscriptionId,
    topicArn, confirmationMessageId: 'synthetic-message', tokenFingerprint: createHash('sha256').update(token).digest('hex'),
  };
  const challenge: StreamConfirmationChallenge = { messageId: intent.confirmationMessageId, topicArn, token,
    subscribeUrl: `https://sns.us-east-1.amazonaws.com/?${new URLSearchParams({ Action: 'ConfirmSubscription', TopicArn: topicArn, Token: token })}` };
  return { intent, challenge };
}

describe('sponsored Stream subscription OpenAPI transport', () => {
  it('lists all pages with startingToken and counted canonical duplicates/refusals', async () => {
    const { api, fetch } = client([{ subscriptions: [row], nextToken: 'synthetic-next' },
      { subscriptions: [row, { ...row, subscriptionId: 'second' }, { ...row, dataSetId: 'dsp-traffic' }] }]);
    const result = await api.list(scope);
    expect(result).toMatchObject({ sourceRows: 4, parsedRows: 3, refusedRows: 1, duplicateRows: 1, complete: false });
    expect(result.subscriptions).toHaveLength(2);
    expect(fetch.mock.calls[1]![0]).toContain('startingToken=synthetic-next');
    expect(fetch.mock.calls[0]![1]?.headers).toMatchObject({ 'Amazon-Advertising-API-Scope': scope.providerProfileId });
  });
  it('refuses malformed rows, conflicting destinations and duplicate revisions without dropping counts', async () => {
    const { api } = client([{ subscriptions: [row, { ...row, status: 'ACTIVE' },
      { ...row, destinationArn: 'arn:aws:sqs:us-east-1:000000000000:other' }, {}] }]);
    expect(await api.list(scope)).toMatchObject({ sourceRows: 4, parsedRows: 1, refusedRows: 3, duplicateRows: 0, complete: false });
  });
  it('detects pagination cycles and preserves empty-complete inventories', async () => {
    const cyclic = client([{ subscriptions: [], nextToken: 'same' }, { subscriptions: [], nextToken: 'same' }]);
    await expect(cyclic.api.list(scope)).rejects.toThrow('refused');
    expect(cyclic.fetch).toHaveBeenCalledTimes(2);
    expect(await client([{ subscriptions: [] }]).api.list(scope)).toMatchObject({ complete: true, sourceRows: 0 });
  });
  it('uses the exact create path, media type, destination and caller token', async () => {
    const { api, fetch } = client([{ subscriptionId: row.subscriptionId, clientRequestToken: createIntent.clientRequestToken }]);
    await expect(api.create(createIntent)).resolves.toEqual({ subscriptionId: row.subscriptionId, clientRequestToken: createIntent.clientRequestToken });
    expect(fetch.mock.calls[0]![0]).toBe('https://advertising-api.amazon.com/streams/subscriptions');
    expect(JSON.parse(fetch.mock.calls[0]![1]?.body as string)).toEqual({ clientRequestToken: createIntent.clientRequestToken,
      dataSetId: scope.datasetId, destination: { sqsDestination: { queueArn: scope.destinationArn } } });
    expect(fetch.mock.calls[0]![1]?.headers).toMatchObject({ 'Content-Type': 'application/vnd.amazonmarketingstreamsubscriptions.v1+json' });
  });
  it('never retries an uncertain create or retains arbitrary provider errors', async () => {
    const fetch = vi.fn(async () => { throw new Error('provider secret response'); });
    const api = new StreamSubscriptionsClient({ scope, clientId: 'synthetic-client', getAccessToken: async () => 'synthetic-access', fetch });
    await expect(api.create(createIntent)).rejects.toThrow('Stream subscription response or request refused');
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(client([{ subscriptionId: row.subscriptionId, clientRequestToken: 'mismatching-request-000001' }]).api.create(createIntent)).rejects.toThrow('refused');
  });
  it('refuses every scope mismatch before HTTP', async () => {
    const { api, fetch } = client([]);
    for (const patch of [{ advertiserId: 'other' }, { providerProfileId: 'other' }, { profileId: scope.orgId },
      { orgId: scope.profileId }, { marketplaceId: 'other' }, { region: 'EU' as const }, { datasetId: 'sb-rich-media' as const },
      { destinationArn: 'arn:aws:sqs:us-east-1:000000000000:other' }]) {
      await expect(api.list({ ...scope, ...patch })).rejects.toThrow('refused');
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it('fetches the exact subscription and only archives on the documented update route', async () => {
    const { api, fetch } = client([{ subscription: row }, null]);
    expect((await api.get(scope, row.subscriptionId)).subscriptionId).toBe(row.subscriptionId);
    const { clientRequestToken: _unused, ...base } = createIntent;
    await api.archive({ ...base, action: 'archive', subscriptionId: row.subscriptionId });
    expect(fetch.mock.calls[1]![1]).toMatchObject({ method: 'PUT', body: '{"status":"ARCHIVED"}' });
    await expect(client([{ subscription: { ...row, subscriptionId: 'wrong' } }]).api.get(scope, row.subscriptionId)).rejects.toThrow('refused');
  });
  it('rejects unsafe confirmation hosts, redirects, ports, duplicate fields and token mismatches', () => {
    const { intent, challenge } = confirmation();
    expect(validateStreamConfirmation(intent, challenge)).toEqual(challenge);
    for (const url of [challenge.subscribeUrl.replace('https:', 'http:'), challenge.subscribeUrl.replace('sns.us-east-1', 'sns.eu-west-1'),
      challenge.subscribeUrl.replace('amazonaws.com', 'amazonaws.com.example.invalid'), challenge.subscribeUrl.replace('.com/', '.com:8080/'),
      `${challenge.subscribeUrl}&Action=ConfirmSubscription`, `${challenge.subscribeUrl}&redirect=https://example.invalid`,
      `${challenge.subscribeUrl}#fragment`]) expect(() => validateStreamConfirmation(intent, { ...challenge, subscribeUrl: url })).toThrow();
    expect(() => validateStreamConfirmation(intent, { ...challenge, token: 'other' })).toThrow();
    expect(() => validateStreamConfirmation(intent, { ...challenge, messageId: 'other' })).toThrow();
  });
  it('confirms through a fixed SNS POST without Ads credentials or fetching SubscribeURL', async () => {
    const { intent, challenge } = confirmation();
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response(`<ConfirmSubscriptionResponse><SubscriptionArn>${intent.topicArn}:synthetic-id</SubscriptionArn></ConfirmSubscriptionResponse>`));
    const token = vi.fn(async () => 'synthetic-access');
    const api = new StreamSubscriptionsClient({ scope, clientId: 'synthetic-client', getAccessToken: token, fetch });
    await api.confirm(intent, challenge);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe('https://sns.us-east-1.amazonaws.com/');
    expect(fetch.mock.calls[0]![1]).toMatchObject({ method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    expect(token).not.toHaveBeenCalled();
  });
});
