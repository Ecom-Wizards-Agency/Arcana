import { describe, expect, it } from 'vitest';
import { SponsoredStreamDatasetId, StreamInfrastructureAuthority, StreamProvisioningIntent,
  StreamSubscriptionInventory, StreamSubscriptionScope } from './stream-subscriptions.js';

const scope = {
  orgId: '00000000-0000-4000-8000-000000000001', profileId: '00000000-0000-4000-8000-000000000002',
  providerProfileId: 'synthetic-profile', advertiserId: 'synthetic-advertiser', marketplaceId: 'synthetic-market',
  region: 'NA', awsRegion: 'us-east-1', datasetId: 'sb-clickstream',
  destinationArn: 'arn:aws:sqs:us-east-1:000000000000:synthetic-stream',
};
describe('Stream infrastructure contracts', () => {
  it('retains seven datasets and admits exactly the eight extensions without DSP', () => {
    for (const dataset of ['sp-traffic', 'sp-conversion', 'sb-traffic', 'sb-conversion', 'sd-traffic', 'sd-conversion',
      'budget-usage', 'sponsored-ads-campaign-diagnostics-recommendations', 'sp-budget-recommendations',
      'ads-campaign-management-campaigns', 'ads-campaign-management-adgroups', 'ads-campaign-management-ads',
      'ads-campaign-management-targets', 'sb-clickstream', 'sb-rich-media']) expect(SponsoredStreamDatasetId.safeParse(dataset).success).toBe(true);
    expect(SponsoredStreamDatasetId.safeParse('dsp-traffic').success).toBe(false);
  });
  it('rejects destination region mismatches', () => {
    expect(StreamSubscriptionScope.safeParse({ ...scope, awsRegion: 'eu-west-1' }).success).toBe(false);
    expect(StreamSubscriptionScope.safeParse(scope).success).toBe(true);
  });
  it('defaults infrastructure authority off and excludes campaign delegation fields', () => {
    const authority = { schemaVersion: 'arcana.stream-infrastructure-authority.v1', authorityId: scope.orgId,
      actorId: scope.profileId, scope, action: 'create', intentFingerprint: 'a'.repeat(64), expiresAt: '2026-09-15T02:00:00Z' };
    expect(StreamInfrastructureAuthority.parse(authority).enabled).toBe(false);
    expect(StreamInfrastructureAuthority.safeParse({ ...authority, actionClass: 'campaign.budget' }).success).toBe(false);
  });
  it('cannot encode activation, destination updates or a durable confirmation URL', () => {
    const intent = { schemaVersion: 'arcana.stream-provisioning-intent.v1', intentId: scope.orgId,
      scope, createdAt: '2026-09-15T00:00:00Z', action: 'archive', subscriptionId: 'synthetic-subscription' };
    expect(StreamProvisioningIntent.safeParse(intent).success).toBe(true);
    expect(StreamProvisioningIntent.safeParse({ ...intent, action: 'activate' }).success).toBe(false);
    expect(StreamProvisioningIntent.safeParse({ ...intent, subscribeUrl: 'https://example.invalid' }).success).toBe(false);
  });
  it('refuses incomplete counts and complete claims with refused rows', () => {
    expect(StreamSubscriptionInventory.safeParse({ subscriptions: [], sourceRows: 1, parsedRows: 0,
      refusedRows: 1, duplicateRows: 0, complete: false }).success).toBe(true);
    expect(StreamSubscriptionInventory.safeParse({ subscriptions: [], sourceRows: 1, parsedRows: 0,
      refusedRows: 1, duplicateRows: 0, complete: true }).success).toBe(false);
  });
});
