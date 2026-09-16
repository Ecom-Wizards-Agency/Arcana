/** Sponsored subscription OpenAPI 3.0 transport. All effects are injected; writes are one attempt.
 * Source: https://dtrnk0o2zy01c.cloudfront.net/openapi/en-us/dest/AmazonMarketingStream_prod_3p.json
 * SNS confirmation: https://docs.aws.amazon.com/sns/latest/api/API_ConfirmSubscription.html
 */
import { createHash } from 'node:crypto';
import {
  StreamConfirmationChallenge, StreamProvisioningIntent, StreamSubscriptionCreated,
  StreamSubscriptionInventory, StreamSubscriptionObservation, StreamSubscriptionScope,
} from '@wizard-ads/shared';
import { adsHeaders } from './headers.js';
import { decodeText, httpRequestOnce } from './http.js';
import { hostFor } from './regions.js';
import type { FetchLike } from './types.js';

export const STREAM_SUBSCRIPTIONS_PATH = '/streams/subscriptions';
export const STREAM_SUBSCRIPTIONS_MEDIA_TYPE = 'application/vnd.amazonmarketingstreamsubscriptions.v1+json';

function refusal(): Error { return new Error('Stream subscription response or request refused'); }
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw refusal();
  return value as Record<string, unknown>;
}
function parseObservation(value: unknown): StreamSubscriptionObservation {
  const row = record(value);
  const destination = row['destination'] === undefined ? undefined : record(row['destination']);
  if (destination?.['firehoseDestination'] !== undefined) throw refusal();
  const sqs = destination?.['sqsDestination'] === undefined ? undefined : record(destination['sqsDestination']);
  const arn = sqs?.['queueArn'] ?? row['destinationArn'];
  if (row['destinationArn'] !== undefined && row['destinationArn'] !== arn) throw refusal();
  const parsed = StreamSubscriptionObservation.safeParse({
    subscriptionId: row['subscriptionId'], datasetId: row['dataSetId'], destinationArn: arn,
    status: row['status'], createdAt: row['createdDate'], updatedAt: row['updatedDate'],
  });
  if (!parsed.success) throw refusal();
  return parsed.data;
}

/** Validate the exact approved SNS challenge. The SubscribeURL is never fetched. */
export function validateStreamConfirmation(
  rawIntent: Extract<StreamProvisioningIntent, { action: 'confirm' }>, rawChallenge: StreamConfirmationChallenge,
): StreamConfirmationChallenge {
  const intent = StreamProvisioningIntent.parse(rawIntent);
  const challenge = StreamConfirmationChallenge.parse(rawChallenge);
  if (intent.action !== 'confirm' || intent.topicArn.split(':')[3] !== intent.scope.awsRegion
    || challenge.topicArn !== intent.topicArn || challenge.messageId !== intent.confirmationMessageId
    || createHash('sha256').update(challenge.token).digest('hex') !== intent.tokenFingerprint) throw refusal();
  const url = new URL(challenge.subscribeUrl);
  const expected: Record<string, string> = {
    Action: 'ConfirmSubscription', TopicArn: challenge.topicArn, Token: challenge.token,
  };
  if (url.protocol !== 'https:' || url.hostname !== `sns.${intent.scope.awsRegion}.amazonaws.com`
    || url.port !== '' || url.username !== '' || url.password !== '' || url.hash !== '' || url.pathname !== '/') throw refusal();
  for (const [name, value] of Object.entries(expected)) {
    if (url.searchParams.getAll(name).length !== 1 || url.searchParams.get(name) !== value) throw refusal();
  }
  for (const [name, value] of url.searchParams) {
    if (name in expected) continue;
    if (name !== 'Version' || value !== '2010-03-31' || url.searchParams.getAll(name).length !== 1) throw refusal();
  }
  return challenge;
}

export class StreamSubscriptionsClient {
  private readonly scope: StreamSubscriptionScope;
  constructor(private readonly input: {
    scope: StreamSubscriptionScope; clientId: string;
    getAccessToken: (force: boolean, signal?: AbortSignal) => Promise<string>;
    fetch: FetchLike;
  }) { this.scope = StreamSubscriptionScope.parse(input.scope); }

  private checkScope(scope: StreamSubscriptionScope): void {
    if (JSON.stringify(StreamSubscriptionScope.parse(scope)) !== JSON.stringify(this.scope)) throw refusal();
  }

  private async request(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<unknown> {
    try {
      const response = await httpRequestOnce({ fetch: this.input.fetch }, {
        method, url: `${hostFor(this.scope.region)}${path}`,
        headers: adsHeaders(this.input.getAccessToken, { clientId: this.input.clientId,
          profileId: this.scope.providerProfileId, contentType: STREAM_SUBSCRIPTIONS_MEDIA_TYPE }),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error', timeoutMs: 30_000, maxResponseBytes: 4_000_000,
      });
      if (response.status !== 200) throw refusal();
      return response.body.length === 0 ? null : JSON.parse(decodeText(response.body)) as unknown;
    } catch { throw refusal(); }
  }

  async list(scope: StreamSubscriptionScope): Promise<StreamSubscriptionInventory> {
    this.checkScope(scope);
    const subscriptions = new Map<string, StreamSubscriptionObservation>();
    const tokens = new Set<string>();
    let sourceRows = 0; let parsedRows = 0; let refusedRows = 0; let duplicateRows = 0;
    let nextToken: string | undefined;
    do {
      const query = new URLSearchParams({ maxResults: '5000' });
      if (nextToken !== undefined) query.set('startingToken', nextToken);
      const body = record(await this.request('GET', `${STREAM_SUBSCRIPTIONS_PATH}?${query}`));
      const rows = body['subscriptions'];
      if (!Array.isArray(rows) || rows.length > 5000) throw refusal();
      sourceRows += rows.length;
      for (const row of rows) {
        try {
          const observation = parseObservation(row);
          const prior = subscriptions.get(observation.subscriptionId);
          if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(observation)) throw refusal();
          if (prior !== undefined) duplicateRows += 1;
          else subscriptions.set(observation.subscriptionId, observation);
          parsedRows += 1;
        } catch { refusedRows += 1; }
      }
      const rawNext = body['nextToken'];
      if (rawNext !== undefined && (typeof rawNext !== 'string' || rawNext.length === 0)) throw refusal();
      nextToken = rawNext as string | undefined;
      if (nextToken !== undefined) {
        if (tokens.has(nextToken) || tokens.size >= 1000) throw refusal();
        tokens.add(nextToken);
      }
    } while (nextToken !== undefined);
    return StreamSubscriptionInventory.parse({ subscriptions: [...subscriptions.values()], sourceRows,
      parsedRows, refusedRows, duplicateRows, complete: refusedRows === 0 });
  }

  async get(scope: StreamSubscriptionScope, subscriptionId: string): Promise<StreamSubscriptionObservation> {
    this.checkScope(scope);
    const result = parseObservation(record(await this.request('GET',
      `${STREAM_SUBSCRIPTIONS_PATH}/${encodeURIComponent(subscriptionId)}`))['subscription']);
    if (result.subscriptionId !== subscriptionId) throw refusal();
    return result;
  }

  async create(rawIntent: Extract<StreamProvisioningIntent, { action: 'create' }>): Promise<StreamSubscriptionCreated> {
    const intent = StreamProvisioningIntent.parse(rawIntent);
    if (intent.action !== 'create') throw refusal();
    this.checkScope(intent.scope);
    const response = await this.request('POST', STREAM_SUBSCRIPTIONS_PATH, {
      clientRequestToken: intent.clientRequestToken, dataSetId: intent.scope.datasetId,
      destination: { sqsDestination: { queueArn: intent.scope.destinationArn } },
    });
    const created = StreamSubscriptionCreated.safeParse(response);
    if (!created.success || created.data.clientRequestToken !== intent.clientRequestToken) throw refusal();
    return created.data;
  }

  /** The published update contract supports ARCHIVED; activation/destination edits are absent. */
  async archive(rawIntent: Extract<StreamProvisioningIntent, { action: 'archive' }>): Promise<void> {
    const intent = StreamProvisioningIntent.parse(rawIntent);
    if (intent.action !== 'archive') throw refusal();
    this.checkScope(intent.scope);
    await this.request('PUT', `${STREAM_SUBSCRIPTIONS_PATH}/${encodeURIComponent(intent.subscriptionId)}`, { status: 'ARCHIVED' });
  }

  async confirm(intent: Extract<StreamProvisioningIntent, { action: 'confirm' }>, rawChallenge: StreamConfirmationChallenge): Promise<void> {
    this.checkScope(intent.scope);
    const challenge = validateStreamConfirmation(intent, rawChallenge);
    try {
      const response = await httpRequestOnce({ fetch: this.input.fetch }, {
        method: 'POST', url: `https://sns.${intent.scope.awsRegion}.amazonaws.com/`,
        headers: async () => ({ 'Content-Type': 'application/x-www-form-urlencoded' }),
        body: new URLSearchParams({ Action: 'ConfirmSubscription', Version: '2010-03-31',
          TopicArn: challenge.topicArn, Token: challenge.token }).toString(),
        redirect: 'error', timeoutMs: 30_000, maxResponseBytes: 16_384,
      });
      const xml = decodeText(response.body);
      const matches = [...xml.matchAll(/<SubscriptionArn>([^<]+)<\/SubscriptionArn>/g)];
      if (response.status !== 200 || matches.length !== 1 || !matches[0]![1]!.startsWith(`${challenge.topicArn}:`)
        || !/^[A-Za-z0-9:_.-]+$/.test(matches[0]![1]!)) throw refusal();
    } catch { throw refusal(); }
  }
}
