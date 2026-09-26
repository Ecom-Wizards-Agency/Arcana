import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { StreamInfrastructureAuthority, StreamProvisioningReceipt, type StreamProvisioningIntent,
  type StreamSubscriptionObservation, type StreamSubscriptionScope } from '@wizard-ads/shared';
import { executeStreamProvisioning, streamProvisioningFingerprint, type StreamProvisioningStore } from './stream-provisioning.js';

const scope: StreamSubscriptionScope = {
  orgId: '00000000-0000-4000-8000-000000000001', profileId: '00000000-0000-4000-8000-000000000002',
  providerProfileId: 'synthetic-profile', advertiserId: 'synthetic-advertiser', marketplaceId: 'synthetic-market',
  region: 'NA', awsRegion: 'us-east-1', datasetId: 'sb-clickstream',
  destinationArn: 'arn:aws:sqs:us-east-1:000000000000:synthetic-stream',
};
const intent: Extract<StreamProvisioningIntent, { action: 'create' }> = {
  schemaVersion: 'arcana.stream-provisioning-intent.v1', intentId: scope.orgId, scope,
  createdAt: '2026-09-15T00:00:00Z', action: 'create', clientRequestToken: 'synthetic-request-00000001',
};
const observation: StreamSubscriptionObservation = { subscriptionId: 'synthetic-subscription', datasetId: scope.datasetId,
  destinationArn: scope.destinationArn, status: 'PENDING_CONFIRMATION', createdAt: intent.createdAt, updatedAt: intent.createdAt };
function fixture(selected: StreamProvisioningIntent = intent) {
  const authority = StreamInfrastructureAuthority.parse({ schemaVersion: 'arcana.stream-infrastructure-authority.v1',
    authorityId: scope.orgId, actorId: scope.profileId, enabled: true, scope: selected.scope, action: selected.action,
    intentFingerprint: streamProvisioningFingerprint(selected), expiresAt: '2026-09-16T00:00:00Z' });
  let retained: StreamProvisioningReceipt | undefined;
  const store: StreamProvisioningStore = {
    reserve: vi.fn(async (savedIntent, savedAuthority, fingerprint, now) => {
      if (retained) return { created: false, receipt: retained };
      retained = StreamProvisioningReceipt.parse({ intentId: savedIntent.intentId, intentFingerprint: fingerprint,
        authorityId: savedAuthority.authorityId, state: 'reserved', subscriptionId: null, recordedAt: now, observedAt: null });
      return { created: true, receipt: retained };
    }),
    finish: vi.fn(async (receipt: StreamProvisioningReceipt) => { retained = structuredClone(receipt); return structuredClone(receipt); }),
  };
  const provider = {
    create: vi.fn(async () => ({ subscriptionId: observation.subscriptionId, clientRequestToken: intent.clientRequestToken })),
    archive: vi.fn(async () => undefined), confirm: vi.fn(async () => undefined),
    get: vi.fn(async () => observation), list: vi.fn(async () => ({ subscriptions: [observation], sourceRows: 1,
      parsedRows: 1, refusedRows: 0, duplicateRows: 0, complete: true })),
  };
  return { enabled: true, intent: selected, authority, store, provider, now: () => new Date('2026-09-15T01:00:00Z') };
}
function archiveIntent(): StreamProvisioningIntent {
  return { schemaVersion: intent.schemaVersion, intentId: intent.intentId, scope, createdAt: intent.createdAt,
    action: 'archive', subscriptionId: observation.subscriptionId };
}
describe('separate Stream infrastructure authority', () => {
  it('is off by default and refuses missing/disabled/expired authority before any side effect', async () => {
    const f = fixture();
    for (const input of [{ ...f, enabled: undefined }, { ...f, authority: undefined },
      { ...f, authority: { ...f.authority, enabled: false } },
      { ...f, authority: { ...f.authority, expiresAt: intent.createdAt } }]) await expect(executeStreamProvisioning(input)).rejects.toThrow();
    expect(f.store.reserve).not.toHaveBeenCalled();
    for (const method of Object.values(f.provider)) expect(method).not.toHaveBeenCalled();
  });
  it('binds immutable intent, action, advertiser, destination, profile and region', async () => {
    const f = fixture();
    for (const patch of [{ advertiserId: 'other' }, { profileId: scope.orgId }, { region: 'EU' as const },
      { destinationArn: 'arn:aws:sqs:us-east-1:000000000000:other' }]) {
      await expect(executeStreamProvisioning({ ...f, intent: { ...intent, scope: { ...scope, ...patch } } })).rejects.toThrow();
    }
    await expect(executeStreamProvisioning({ ...f, intent: { ...intent, clientRequestToken: 'changed-request-000000001' } })).rejects.toThrow();
    await expect(executeStreamProvisioning({ ...f, authority: { ...f.authority, action: 'archive' } })).rejects.toThrow();
    expect(f.provider.create).not.toHaveBeenCalled();
    expect(f.store.reserve).not.toHaveBeenCalled();
  });
  it('reserves before one create, distinguishes accepted from observed and preserves original receipt time', async () => {
    const f = fixture();
    const accepted = await executeStreamProvisioning(f);
    expect(accepted.state).toBe('accepted');
    expect(f.store.reserve).toHaveBeenCalledTimes(1);
    expect(f.provider.create).toHaveBeenCalledTimes(1);
    const replay = await executeStreamProvisioning({ ...f, now: () => new Date('2026-09-15T02:00:00Z') });
    expect(replay).toMatchObject({ state: 'observed', recordedAt: accepted.recordedAt, subscriptionId: observation.subscriptionId });
    expect(f.provider.create).toHaveBeenCalledTimes(1);
    expect(f.provider.get).toHaveBeenCalledTimes(1);
  });
  it('keeps a lost create uncertain even with one matching subscription and never blindly resends', async () => {
    const f = fixture();
    f.provider.create.mockRejectedValue(new Error('arbitrary provider response'));
    const first = await executeStreamProvisioning(f);
    expect(first).toMatchObject({ state: 'uncertain', subscriptionId: null });
    const replay = await executeStreamProvisioning(f);
    expect(replay.state).toBe('uncertain');
    expect(f.provider.create).toHaveBeenCalledTimes(1);
    expect(f.provider.list).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(replay)).not.toContain('arbitrary');
  });
  it('reconciles a crash after reservation through reads without creating another subscription', async () => {
    const f = fixture();
    await f.store.reserve(intent, f.authority, streamProvisioningFingerprint(intent), f.now().toISOString());
    expect((await executeStreamProvisioning(f)).state).toBe('uncertain');
    expect(f.provider.create).not.toHaveBeenCalled();
    expect(f.provider.list).toHaveBeenCalledTimes(1);
  });
  it('keeps incomplete inventories uncertain and exposes multiple matching subscriptions as conflicts', async () => {
    const f = fixture();
    f.provider.create.mockRejectedValue(new Error('unknown outcome'));
    await executeStreamProvisioning(f);
    f.provider.list.mockResolvedValue({ subscriptions: [observation], sourceRows: 2, parsedRows: 1,
      refusedRows: 1, duplicateRows: 0, complete: false });
    expect((await executeStreamProvisioning(f)).state).toBe('uncertain');
    f.provider.list.mockResolvedValue({ subscriptions: [observation, { ...observation, subscriptionId: 'second' }],
      sourceRows: 2, parsedRows: 2, refusedRows: 0, duplicateRows: 0, complete: true });
    expect((await executeStreamProvisioning(f)).state).toBe('conflict');
    expect(f.provider.create).toHaveBeenCalledTimes(1);
  });
  it('requires independent receipt readback agreement', async () => {
    const f = fixture();
    f.store.finish = vi.fn(async receipt => ({ ...receipt, state: 'reserved' }));
    await expect(executeStreamProvisioning(f)).rejects.toThrow('readback mismatch');
    expect(f.provider.create).toHaveBeenCalledTimes(1);
  });
  it('checks the stored subscription destination before archive and observes archive on reconciliation', async () => {
    const f = fixture(archiveIntent());
    f.provider.get.mockResolvedValueOnce({ ...observation, destinationArn: 'arn:aws:sqs:us-east-1:000000000000:other' });
    expect((await executeStreamProvisioning(f)).state).toBe('uncertain');
    expect(f.provider.archive).not.toHaveBeenCalled();
    const valid = fixture(archiveIntent());
    expect((await executeStreamProvisioning(valid)).state).toBe('accepted');
    valid.provider.get.mockResolvedValue({ ...observation, status: 'ARCHIVED' });
    expect((await executeStreamProvisioning(valid)).state).toBe('observed');
    expect(valid.provider.archive).toHaveBeenCalledTimes(1);
  });
  it('does not confirm without a matched challenge and pending provider state', async () => {
    const topicArn = 'arn:aws:sns:us-east-1:000000000000:synthetic-topic';
    const token = 'synthetic-confirmation';
    const selected: StreamProvisioningIntent = { schemaVersion: intent.schemaVersion, intentId: intent.intentId,
      createdAt: intent.createdAt, scope, action: 'confirm', subscriptionId: observation.subscriptionId,
      topicArn, confirmationMessageId: 'synthetic-message', tokenFingerprint: createHash('sha256').update(token).digest('hex') };
    const f = fixture(selected);
    const challenge = { messageId: 'synthetic-message', topicArn, token, subscribeUrl:
      `https://sns.us-east-1.amazonaws.com/?${new URLSearchParams({ Action: 'ConfirmSubscription', TopicArn: topicArn, Token: token })}` };
    await expect(executeStreamProvisioning({ ...f, challenge: { ...challenge, subscribeUrl: 'https://example.invalid/' } })).rejects.toThrow();
    expect(f.store.reserve).not.toHaveBeenCalled();
    expect((await executeStreamProvisioning({ ...f, challenge })).state).toBe('accepted');
    f.provider.get.mockResolvedValue({ ...observation, status: 'ACTIVE' });
    expect((await executeStreamProvisioning({ ...f, challenge })).state).toBe('observed');
    expect(f.provider.confirm).toHaveBeenCalledTimes(1);
    for (const call of vi.mocked(f.store.finish).mock.calls) {
      expect(JSON.stringify(call)).not.toContain(token);
      expect(JSON.stringify(call)).not.toContain('subscribeUrl');
    }
    const notPending = fixture(selected);
    notPending.provider.get.mockResolvedValue({ ...observation, status: 'PROVISIONING' });
    expect((await executeStreamProvisioning({ ...notPending, challenge })).state).toBe('conflict');
    expect(notPending.provider.confirm).not.toHaveBeenCalled();
  });
});
