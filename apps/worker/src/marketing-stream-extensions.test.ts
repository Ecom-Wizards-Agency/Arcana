import { expect, it, vi } from 'vitest';
import { StreamExtensionReceipt, type StreamExtensionBinding, type StreamExtensionEvent } from '@wizard-ads/shared';
import { StreamExtensionIntake } from './marketing-stream-extensions.js';
import { MarketingStreamSqsConsumer } from './marketing-stream-sqs.js';
import type { MarketingStreamStore } from './dayparting.js';
import { ingestionLaneJobTypes, ingestionSource } from './ingestion-sources.js';
import { defaultSchedules } from './schedules.js';

const binding: StreamExtensionBinding = { orgId: '00000000-0000-4000-8000-000000000001',
  profileId: '00000000-0000-4000-8000-000000000002', datasetId: 'ads-campaign-management-campaigns', subscriptionId: 'subscription',
  advertiserId: 'advertiser', marketplaceId: 'market', region: 'EU', destinationArn: 'arn:aws:sqs:eu-west-1:000000000000:synthetic',
  enabled: true, confirmed: true, capabilityVerified: true, contractVersion: 'fixture.v1' };
const record = { contractVersion: 'fixture.v1', datasetId: binding.datasetId, subscriptionId: binding.subscriptionId,
  advertiserId: binding.advertiserId, marketplaceId: binding.marketplaceId, region: binding.region, destinationArn: binding.destinationArn,
  eventId: 'event', revision: 1, eventTime: '2026-09-01T00:00:00.000Z', window: null,
  observation: { entityId: 'campaign', adProduct: 'SP', operation: 'patch', name: 'Synthetic campaign' } };
function harness(b = binding, enabled = true, syntheticAdapter = true) {
  const events: StreamExtensionEvent[] = [];
  const retain = vi.fn(async (input) => {
    if (input.event) events.push(input.event);
    return StreamExtensionReceipt.parse({ deliveryId: input.deliveryId, bodyFingerprint: input.bodyFingerprint, receivedAt: input.receivedAt,
      outcome: input.reason === null ? 'accepted' : 'rejected', reason: input.reason,
      counts: { received: 1, undecodable: input.decoded === 0 ? 1 : 0, decoded: input.decoded, accepted: input.event ? 1 : 0, stored: input.event ? 1 : 0,
        deduplicated: 0, rejected: input.event ? 0 : input.decoded, deadLettered: 0, verifiedStored: input.event ? 1 : 0 } });
  });
  const intake = new StreamExtensionIntake({ enabled, syntheticAdapter, destinationArn: binding.destinationArn,
    now: () => new Date('2026-09-02T00:00:00.000Z'), store: { binding: async () => b, retain } });
  return { events, retain, intake };
}
it('has only integrations affinity and no fabricated event schedule', () => {
  expect(ingestionSource('marketing_stream.extensions.project').laneAffinity).toEqual(['integrations']);
  expect(ingestionSource('marketing_stream.normalize').laneAffinity).toEqual([]);
  for (const lane of ['vercel-default', 'vercel-reduced', 'evo-report', 'evo-report-unified', 'evo-recommendation'] as const)
    expect(ingestionLaneJobTypes(lane)).not.toContain('marketing_stream.extensions.project');
  expect(new Set<string>(defaultSchedules().map((s) => s.jobType)).has('marketing_stream.extensions.project')).toBe(false);
});
it('accepts explicitly enabled fixture adapters, preserves source time and deterministic identity', async () => {
  const h = harness();
  const first = await h.intake.retain({ messageId: 'one', body: JSON.stringify(record) });
  expect(first.counts).toMatchObject({ decoded: 1, accepted: 1, stored: 1, verifiedStored: 1 });
  await h.intake.retain({ messageId: 'two', body: JSON.stringify(record) });
  expect(h.events[0]?.identity).toBe(h.events[1]?.identity);
  expect(h.events[0]?.record.eventTime).toBe(record.eventTime);
  expect(h.events[0]?.receivedAt).not.toBe(record.eventTime);
});
it.each(['advertiserId', 'marketplaceId', 'region', 'destinationArn', 'datasetId', 'contractVersion'] as const)('refuses %s mismatch before persistence', async (key) => {
  const h = harness({ ...binding, [key]: 'different' } as StreamExtensionBinding);
  const result = await h.intake.retain({ messageId: 'one', body: JSON.stringify(record) });
  expect(result.reason).toBe('binding_mismatch');
  expect(h.events).toHaveLength(0);
  expect(h.retain).toHaveBeenCalledTimes(1);
});
it('refuses unconfirmed, disabled and unknown schemas durably, including arbitrary confirmation URLs', async () => {
  expect((await harness({ ...binding, confirmed: false }).intake.retain({ messageId: 'one', body: JSON.stringify(record) })).reason).toBe('unconfirmed');
  expect((await harness(binding, false).intake.retain({ messageId: 'one', body: JSON.stringify(record) })).reason).toBe('disabled');
  expect((await harness(binding, true, false).intake.retain({ messageId: 'one', body: JSON.stringify(record) })).reason).toBe('unsupported_schema');
  const h = harness();
  expect((await h.intake.retain({ messageId: 'bad', body: JSON.stringify({ Type: 'SubscriptionConfirmation', SubscribeURL: 'https://invalid.example/' }) })).reason).toBe('unsupported_schema');
  expect((await h.intake.retain({ messageId: 'json', body: '{' })).counts.decoded).toBe(0);
  expect(h.events).toHaveLength(0);
});
it('reuses SQS acknowledgment only after durable intake; a crash leaves the message unacknowledged', async () => {
  const h = harness();
  const deleteMessage = vi.fn();
  let crash = true;
  const consumer = new MarketingStreamSqsConsumer({ queueUrl: 'https://sqs.example.invalid/synthetic',
    queue: { receive: async () => [{ messageId: 'one', receiptHandle: 'receipt', body: JSON.stringify(record), approximateReceiveCount: 1 }],
      delete: deleteMessage, destroy: vi.fn() },
    store: {} as MarketingStreamStore, contexts: { load: vi.fn() }, logger: { info: vi.fn(), error: vi.fn() },
    extensionIntake: async (message) => { if (crash) throw new Error('fixture persistence failure');
      return h.intake.retain({ messageId: message.messageId!, body: message.body! }); },
  });
  await consumer.pollOnce();
  expect(deleteMessage).not.toHaveBeenCalled();
  crash = false;
  await consumer.pollOnce();
  expect(deleteMessage).toHaveBeenCalledTimes(1);
  expect(h.retain).toHaveBeenCalledTimes(1);
});
