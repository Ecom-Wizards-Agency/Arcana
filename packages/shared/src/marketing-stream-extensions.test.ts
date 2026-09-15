import { expect, it } from 'vitest';
import { AmazonMarketingStreamDatasetId } from './dayparting.js';
import { StreamExtensionBinding, StreamExtensionCounts, StreamExtensionDataset, StreamExtensionRecord } from './marketing-stream-extensions.js';

it('retains seven hourly datasets separately from the exact eight extensions and refuses DSP', () => {
  expect(AmazonMarketingStreamDatasetId.options).toHaveLength(7);
  expect(StreamExtensionDataset.options).toHaveLength(8);
  for (const id of ['adsp-traffic', 'adsp-conversion', 'adsp-clickstream', 'adsp-rich-media'])
    expect(StreamExtensionDataset.safeParse(id).success).toBe(false);
  for (const id of StreamExtensionDataset.options) expect(AmazonMarketingStreamDatasetId.safeParse(id).success).toBe(false);
});
it('default binding does not admit consumption, confirmation or capability', () => {
  const binding = StreamExtensionBinding.parse({ orgId: '00000000-0000-4000-8000-000000000001',
    profileId: '00000000-0000-4000-8000-000000000002', datasetId: 'sb-clickstream', subscriptionId: 'sub',
    advertiserId: 'advertiser', marketplaceId: 'market', region: 'EU',
    destinationArn: 'arn:aws:sqs:eu-west-1:000000000000:synthetic', contractVersion: 'fixture.v1' });
  expect([binding.enabled, binding.confirmed, binding.capabilityVerified]).toEqual([false, false, false]);
});
it('counts independent durable readback and distinguishes duplicates from new storage', () => {
  const counts = { received: 1, undecodable: 0, decoded: 3, accepted: 2, stored: 1, deduplicated: 1, rejected: 1, deadLettered: 0, verifiedStored: 2 };
  expect(StreamExtensionCounts.parse(counts)).toEqual(counts);
  for (const key of ['decoded', 'accepted', 'verifiedStored'])
    expect(StreamExtensionCounts.safeParse({ ...counts, [key]: 9 }).success).toBe(false);
});
it('refuses person-level click data and aggregates without windows', () => {
  const record = { contractVersion: 'fixture.v1', datasetId: 'sb-clickstream', subscriptionId: 'sub', advertiserId: 'advertiser',
    marketplaceId: 'market', region: 'EU', destinationArn: 'arn:aws:sqs:eu-west-1:000000000000:synthetic',
    eventId: 'event', revision: 1, eventTime: '2026-09-01T12:00:00.000Z',
    window: { start: '2026-09-01T11:00:00.000Z', end: '2026-09-01T12:00:00.000Z' },
    observation: { campaignId: 'campaign', creativeId: 'creative', clicks: 1 } };
  expect(StreamExtensionRecord.parse(record)).toEqual(record);
  expect(StreamExtensionRecord.safeParse({ ...record, window: null }).success).toBe(false);
  expect(StreamExtensionRecord.safeParse({ ...record, observation: { ...record.observation, personId: 'private' } }).success).toBe(false);
});
